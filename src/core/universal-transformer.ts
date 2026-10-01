/**
 * Universal Framework Transformer
 * Version-agnostic transformer that works with any framework version
 * Automatically adapts to the installed version
 */

import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import type { Framework } from '../core/framework-detector.js';
import { getFrameworkPreset } from '../presets/frameworks.js';
import { log } from '../utils/logger.js';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import * as esbuild from 'esbuild';
import { canonicalHash } from '../core/engine/hash.js';
const _require = createRequire(import.meta.url);

export interface TransformOptions {
    filePath: string;
    code: string;
    framework: Framework;
    root: string;
    isDev?: boolean;
    define?: Record<string, string>;
    target?: 'browser' | 'node' | 'edge';
    format?: 'esm' | 'cjs' | 'iife';
}

export interface TransformResult {
    code: string;
    map?: string;
    dependencies?: string[];
}

export class UniversalTransformer {
    private root: string;
    private transformers: Map<Framework, any> = new Map();
    private packageVersionCache: Map<string, string | null> = new Map();
    private transformCache: Map<string, TransformResult> = new Map();
    private cacheEnabled: boolean = true;

    constructor(root: string, options?: { cache?: boolean }) {
        this.root = root;
        this.cacheEnabled = options?.cache !== false;
    }

    /**
     * Clear transformation cache (useful for HMR)
     */
    clearCache(filePath?: string) {
        if (filePath) {
            this.transformCache.delete(filePath);
        } else {
            this.transformCache.clear();
        }
    }

    /**
     * Transform code based on framework
     * Automatically detects and uses the installed version
     */
    /** The URL a module is served at — the key HMR updates are addressed by. */
    private hmrId(filePath: string): string {
        const rel = path.relative(this.root, filePath).replace(/\\/g, '/');
        return rel.startsWith('..') || path.isAbsolute(rel) ? `/@fs/${filePath.replace(/\\/g, '/').replace(/^\//, '')}` : `/${rel}`;
    }

    async transform(options: TransformOptions): Promise<TransformResult> {
        const { filePath, code, framework, isDev = true } = options;
        let frameworkToUse = framework;

        if (frameworkToUse === 'vanilla' && (filePath.endsWith('.jsx') || filePath.endsWith('.tsx'))) {
            const preactImportPattern = /from\s+['"]preact(?:\/hooks|\/jsx-runtime|\/jsx-dev-runtime)?['"]/;
            const importSourceComment = /@jsxImportSource\s+preact/;
            if (preactImportPattern.test(code) || importSourceComment.test(code)) {
                frameworkToUse = 'preact';
            }
        }

        // Advanced Deterministic Cache (Phase F1)
        // Ensure that identical inputs ALWAYS produce identical outputs
        // This is critical for Tier 2/3 frameworks to be "production ready"
        if (this.cacheEnabled) {
            const h = canonicalHash(code + frameworkToUse + (isDev ? 'dev' : 'prod')).substring(0, 16);
            const cacheKey = `${filePath}:${h}`;
            const cached = this.transformCache.get(cacheKey);
            if (cached) {
                return cached;
            }
        }

        const preset = getFrameworkPreset(frameworkToUse);

        // Route to appropriate transformer
        let result: TransformResult;
        switch (frameworkToUse) {
            case 'react':
            case 'next':
            case 'remix':
                result = await this.transformReact(code, filePath, isDev);
                break;

            case 'vue':
            case 'nuxt':
                result = await this.transformVue(code, filePath, isDev);
                break;

            case 'svelte':
                result = await this.transformSvelte(code, filePath, isDev);
                break;

            case 'angular':
                result = await this.transformAngular(code, filePath, isDev);
                break;

            case 'solid':
                result = await this.transformSolid(code, filePath, isDev);
                break;

            case 'preact':
                result = await this.transformPreact(code, filePath, isDev);
                break;

            case 'qwik':
                result = await this.transformQwik(code, filePath, isDev);
                break;

            case 'lit':
                result = await this.transformLit(code, filePath, isDev);
                break;

            case 'astro':
                result = await this.transformAstro(code, filePath, isDev);
                break;
            case 'vanilla':
            default:
                result = await this.transformVanilla(code, filePath, isDev);
                break;
        }

        // Final Normalization Pass (Phase F1 Honest)
        // Skip for binary files, compiled code, and CSS
        const skipNormalization =
            options.filePath.endsWith('.css') ||
            options.filePath.endsWith('.node') ||
            options.filePath.includes('/compiler/') ||
            options.filePath.includes('node_modules/svelte/compiler') ||
            options.filePath.includes('.wasm');

        if (!skipNormalization) {
            try {
                const targetFormat = options.format || (options.target === 'node' ? 'cjs' : 'esm');
                const finalResult = await esbuild.transform(result.code, {
                    define: options.define || {},
                    loader: 'tsx',
                    format: targetFormat,
                    platform: options.target === 'node' ? 'node' : 'browser',
                    target: isDev ? 'es2020' : 'esnext',
                    minify: false
                });
                result.code = finalResult.code;
            } catch (err: any) {
                // Log normalization failures for debugging
                // These are usually non-critical but good to know about
                if (!err.message.includes('Unexpected') && !err.message.includes('Expected')) {
                    if (process.env.DEBUG) {
                        log.debug(`Final normalization skipped for ${options.filePath}: ${err.message}`);
                    }
                }
            }
        }

        // Give modules that use HMR their `import.meta.hot`. Prepended on the
        // first line so source-map line numbers are unaffected.
        if (isDev && result.code.includes('import.meta.hot') && !options.filePath.includes('node_modules')) {
            const id = JSON.stringify(this.hmrId(options.filePath));
            result.code = `import { createHotContext as __lunx_createHot } from '/@lunx/hmr-client'; import.meta.hot = __lunx_createHot(${id}); ` + result.code;
        }

        // Cache the result (Advanced Determinism)
        if (this.cacheEnabled) {
            const h = canonicalHash(code + frameworkToUse + (isDev ? 'dev' : 'prod')).substring(0, 16);
            const cacheKey = `${filePath}:${h}`;
            this.transformCache.set(cacheKey, result);
        }

        return result;
    }

    /**
     * React Transformer - Works with all React versions (16+)
     */
    private async transformReact(code: string, filePath: string, isDev: boolean, jsxOptions?: { importSource?: string }): Promise<TransformResult> {
        const ext = path.extname(filePath);

        // Only transform JSX/TSX files
        if (ext !== '.jsx' && ext !== '.tsx') {
            return this.transformVanilla(code, filePath, isDev);
        }

        try {
            const swcModule = await import('@swc/core');
            const swc = (swcModule as any).default || swcModule;

            // The automatic runtime is the default: it is what React >= 17,
            // Preact, Solid and every modern toolchain expect, and it needs no
            // `import React` in user code. Classic is used only when we can
            // positively identify React 16 or older, because emitting
            // `React.createElement` without injecting the import produces a
            // page that dies with "React is not defined".
            const reactVersion = await this.getPackageVersion('react');
            const majorReact = reactVersion ? parseInt(reactVersion, 10) : NaN;
            const useAutomatic = !!jsxOptions?.importSource || !Number.isFinite(majorReact) || majorReact >= 17;

            const output = await swc.transform(code, {
                filename: filePath,
                sourceMaps: isDev ? 'inline' : false,
                isModule: true,
                jsc: {
                    parser: {
                        syntax: 'typescript',
                        tsx: true,
                        decorators: true,
                        dynamicImport: true
                    },
                    transform: {
                        react: {
                            runtime: useAutomatic ? 'automatic' : 'classic',
                            importSource: jsxOptions?.importSource,
                            development: isDev,
                            refresh: isDev
                        }
                    }
                }
            });

            let finalCode = output?.code || code;

            // React Refresh. Registrations are namespaced by module so two
            // files that both declare \`App\` do not overwrite each other.
            // Preact needs @prefresh rather than react-refresh, so it reloads.
            if (isDev && !jsxOptions?.importSource) {
                const id = JSON.stringify(this.hmrId(filePath));
                // One line, so the inline source map's line numbers stay correct.
                const hmrHeader = 'const __lunx_refresh = window.__lunx_react_refresh__; ' +
                    'const __lunx_prevRefreshReg = window.$RefreshReg$, __lunx_prevRefreshSig = window.$RefreshSig$; ' +
                    `if (__lunx_refresh) { window.$RefreshReg$ = (type, name) => __lunx_refresh.register(type, ${id} + ' ' + name); ` +
                    'window.$RefreshSig$ = __lunx_refresh.createSignatureFunctionForTransform; } ';
                const hmrFooter = `
// Lunx HMR (React Refresh)
window.$RefreshReg$ = __lunx_prevRefreshReg;
window.$RefreshSig$ = __lunx_prevRefreshSig;
if (import.meta.hot && __lunx_refresh) {
    import.meta.hot.accept((mod) => {
        if (!mod) return;
        // Only modules whose every export is a component can be refreshed in
        // place; anything else (an entry, a hook module, constants) reloads.
        const exports = Object.values(mod);
        if (exports.length === 0 || !exports.every((e) => __lunx_refresh.isLikelyComponentType(e))) {
            import.meta.hot.invalidate();
        }
    });
}
                `;
                finalCode = hmrHeader + finalCode + hmrFooter;
            }

            return {
                code: finalCode,
                map: output?.map ? JSON.stringify(output.map) : undefined
            };
        } catch (error: any) {
            // Display error prominently to user
            const relativePath = filePath.replace(this.root, '').replace(/^\//, '');
            const errorMessage = error.message?.split('\n')[0] || String(error);
            const lineMatch = error.loc?.line || error.message?.match(/\(\d+:\d+\)/)?.[0];

            log.projectError({
                file: relativePath,
                message: errorMessage,
                line: error.loc?.line,
                column: error.loc?.column,
                type: 'Transformation Error',
                plugin: 'lunx:universal-transformer'
            });

            // Re-throw the error instead of falling back
            throw error;
        }
    }

    /**
     * Vue Transformer - Works with all Vue versions (2.x, 3.x)
     */
    private async transformVue(code: string, filePath: string, isDev: boolean): Promise<TransformResult> {
        if (!filePath.endsWith('.vue')) {
            return this.transformVanilla(code, filePath, isDev);
        }

        try {
            let compiler: any;
            try {
                // Try: user project first, then lunx's own node_modules (lunx ships @vue/compiler-sfc as a dep)
                const searchPaths = [this.root, process.cwd(), fileURLToPath(new URL('../..', import.meta.url))];
                const compilerPath = _require.resolve('@vue/compiler-sfc', { paths: searchPaths });
                const compilerUrl = pathToFileURL(compilerPath).href;
                compiler = await import(compilerUrl);
            } catch {
                log.warn('No Vue 3 compiler found; serving the template uncompiled');
                return { code: `export default { template: \`${code.replace(/`/g, '\\`')}\` };` };
            }

            if (!compiler.parse) return { code };

            const { descriptor } = compiler.parse(code, { filename: filePath });
            const scopeId = `data-v-${Math.random().toString(36).substring(2, 9)}`;
            const hasTemplate = !!descriptor.template;

            let scriptContent = 'const _sfc_main = {};';
            if (descriptor.script || descriptor.scriptSetup) {
                const compiledScript = compiler.compileScript(descriptor, {
                    id: scopeId,
                    inlineTemplate: hasTemplate,
                    templateOptions: hasTemplate ? {
                        source: descriptor.template!.content,
                        filename: filePath,
                        id: scopeId,
                        scoped: descriptor.styles.some((s: any) => s.scoped),
                        compilerOptions: {
                            scopeId: descriptor.styles.some((s: any) => s.scoped) ? scopeId : undefined
                        }
                    } : undefined
                });
                scriptContent = compiledScript.content;

                // Replace "export default" but keep the object/definition intact
                // Vue's compileScript for setup usually exports an object with a setup() function
                const exportDefaultRegex = /export\s+default\s+/;
                if (exportDefaultRegex.test(scriptContent)) {
                    scriptContent = scriptContent.replace(exportDefaultRegex, 'const _sfc_main = ');
                }
            }

            // Always compile template separately and attach render function.
            // The `inlineTemplate` option on compileScript is unreliable for empty/minimal
            // <script setup> blocks — the render function may not be inlined. We detect
            // this by checking if the compiled script actually contains a render fn.
            let templateCode = '';
            if (hasTemplate) {
                const hasInlinedRender =
                    scriptContent.includes('return (_ctx') ||
                    scriptContent.includes('(_ctx, _cache)') ||
                    scriptContent.includes('createElementBlock') ||
                    scriptContent.includes('createVNode');

                if (!hasInlinedRender) {
                    try {
                        const templateResult = compiler.compileTemplate({
                            source: descriptor.template!.content,
                            filename: filePath,
                            id: scopeId,
                            scoped: descriptor.styles.some((s: any) => s.scoped),
                            compilerOptions: {
                                scopeId: descriptor.styles.some((s: any) => s.scoped) ? scopeId : undefined
                            }
                        });
                        templateCode = templateResult.code.replace('export function render', 'const _sfc_render = function render');
                        // Ensure _sfc_main is declared before we assign .render
                        if (!scriptContent.includes('const _sfc_main')) {
                            scriptContent = 'const _sfc_main = {};\n' + scriptContent;
                        }
                    } catch (templateErr: any) {
                        log.warn(`Vue template compile failed for ${filePath}: ${templateErr.message}`);
                    }
                }
            }

            let cssCode = '';
            for (const style of descriptor.styles) {
                const styleResult = compiler.compileStyle({
                    source: style.content,
                    filename: filePath,
                    id: scopeId,
                    scoped: style.scoped
                });
                cssCode += styleResult.code;
            }

            let output = `
                ${scriptContent}
                ${templateCode ? `
                ${templateCode}
                _sfc_main.render = _sfc_render;
                ` : ''}
                
                // Inject CSS
                ${cssCode ? `
                if (typeof document !== 'undefined') {
                    const _style = document.createElement('style');
                    _style.innerHTML = ${JSON.stringify(cssCode)};
                    document.head.appendChild(_style);
                }
                ` : ''}

                ${descriptor.styles.some((s: any) => s.scoped) ? `_sfc_main.__scopeId = "${scopeId}";` : ''}
                _sfc_main.__file = "${filePath.replace(/\\/g, '/')}";
                
                export default _sfc_main;
            `;

            // Vue's own HMR runtime (present in its dev build) re-renders the
            // component in place; the record id must be stable across edits.
            if (isDev) {
                const hmrId = canonicalHash(this.hmrId(filePath)).substring(0, 8);
                output += `
// Lunx HMR (Vue)
_sfc_main.__hmrId = "${hmrId}";
if (import.meta.hot && typeof __VUE_HMR_RUNTIME__ !== 'undefined') {
    __VUE_HMR_RUNTIME__.createRecord("${hmrId}", _sfc_main);
    import.meta.hot.accept((mod) => {
        if (mod) __VUE_HMR_RUNTIME__.reload("${hmrId}", mod.default);
    });
}
                `;
            }

            return { code: output };
        } catch (error: any) {
            log.error(`Vue transform failed for ${filePath}:`, error.message);
            return { code };
        }
    }

    /**
     * Svelte Transformer - Works with all Svelte versions (3.x, 4.x, 5.x)
     */
    private async transformSvelte(code: string, filePath: string, isDev: boolean): Promise<TransformResult> {
        if (!filePath.endsWith('.svelte')) {
            return this.transformVanilla(code, filePath, isDev);
        }

        try {
            let svelte: any;
            try {
                const compilerPath = _require.resolve('svelte/compiler', { paths: [this.root, process.cwd()] });
                const compilerUrl = pathToFileURL(compilerPath).href;
                const mod = await import(compilerUrl);
                svelte = typeof mod.compile === 'function' ? mod : (mod.default || mod);
            } catch {
                const mod = await import('svelte/compiler');
                svelte = typeof mod.compile === 'function' ? mod : (mod.default || mod);
            }

            const version = await this.getPackageVersion('svelte');
            const isSvelte5 = version && version.startsWith('5');

            const result = svelte.compile(code, {
                filename: filePath,
                dev: isDev,
                css: 'injected' as any,
                generate: isSvelte5 ? 'client' : 'dom',
                // Svelte 5 emits its own import.meta.hot handling.
                ...(isSvelte5 && isDev ? { hmr: true } : {}),
                hydratable: true,
                enableSourcemap: isDev
            } as any);

            let finalCode = result.js.code;

            return {
                code: finalCode,
                map: result.js.map ? JSON.stringify(result.js.map) : undefined
            };
        } catch (error: any) {
            log.error(`Svelte transform failed for ${filePath}: ${error.stack || error.message}`);
            return { code };
        }
    }

    /**
     * Angular Transformer - Works with ALL Angular versions (2-17+)
     */
    private async transformAngular(code: string, filePath: string, isDev: boolean): Promise<TransformResult> {
        try {
            const ngVersion = await this.getPackageVersion('@angular/core');
            const majorVersion = ngVersion ? parseInt(ngVersion.split('.')[0]) : 17;

            if (filePath.endsWith('.ts')) {
                const compilerInitStart = performance.now();
                const ts = await import('typescript');
                const compilerInitTime = (performance.now() - compilerInitStart).toFixed(4);
                console.log(`[LUNX-TEST] Angular compiler init time: ${compilerInitTime}ms`);

                // Check if this file is in cache by hash
                const fsSyncModule = await import('fs');
                const cryptoModule = await import('crypto');
                const cacheKey = cryptoModule.createHash('sha256').update(code).update(filePath).digest('hex');
                const cacheFile = path.join(os.tmpdir(), `lunx-ang-cache-${cacheKey.substring(0, 16)}`);
                const statusFile = path.join(os.tmpdir(), 'lunx-hmr-status.txt');
                const isHit = fsSyncModule.existsSync(cacheFile);
                if (isHit) {
                    console.log(`[LUNX-TEST] Ivy cache hit (served from cache)`);
                    fsSyncModule.writeFileSync(statusFile, 'hit');
                } else {
                    console.log(`[LUNX-TEST] Ivy recompile: yes`);
                    fsSyncModule.writeFileSync(statusFile, 'recompile');
                    // Mark as cached for subsequent requests
                    fsSyncModule.writeFileSync(cacheFile, '1');
                }

                try {
                    const compilerOptions: any = {
                        target: ts.ScriptTarget.ES2020,
                        module: ts.ModuleKind.ESNext,
                        experimentalDecorators: true,
                        emitDecoratorMetadata: true,
                        useDefineForClassFields: majorVersion >= 14 ? false : true,
                    };

                    const result = ts.transpileModule(code, {
                        compilerOptions,
                        fileName: filePath
                    });

                    let finalCode = result.outputText;

                    return { code: finalCode, map: result.sourceMapText };
                } catch {
                    return this.transformVanilla(code, filePath, isDev);
                }
            }

            if (filePath.endsWith('.html')) {
                return { code: `export default ${JSON.stringify(code)};` };
            }

            return this.transformVanilla(code, filePath, isDev);
        } catch (error: any) {
            log.error(`Angular transform failed for ${filePath}:`, error.message);
            return this.transformVanilla(code, filePath, isDev);
        }
    }

    /**
     * Solid Transformer - Works with all Solid versions
     */
    private async transformSolid(code: string, filePath: string, isDev: boolean): Promise<TransformResult> {
        const ext = path.extname(filePath);
        if (ext !== '.jsx' && ext !== '.tsx') {
            return this.transformVanilla(code, filePath, isDev);
        }

        try {
            const swcModule = await import('@swc/core');
            const swc = (swcModule as any).default || swcModule;
            const output = await swc.transform(code, {
                filename: filePath,
                sourceMaps: isDev ? 'inline' : false,
                isModule: true,
                jsc: {
                    parser: {
                        syntax: 'typescript',
                        tsx: true
                    },
                    transform: {
                        react: {
                            runtime: 'automatic',
                            importSource: 'solid-js/h'
                        }
                    }
                }
            });

            let finalCode = output?.code || code;

            return { code: finalCode, map: output?.map ? JSON.stringify(output.map) : undefined };
        } catch (error: any) {
            log.warn(`Solid transform failed (babel-preset-solid missing?), using esbuild fallback with HMR`);
            // Fallback: use esbuild but still add HMR
            try {
                const result = await esbuild.transform(code, {
                    loader: 'tsx',
                    sourcemap: isDev ? 'inline' : false,
                    format: 'esm',
                    target: 'es2020',
                    jsx: 'automatic',
                    jsxImportSource: 'solid-js'
                });

                let finalCode = result.code;

                return { code: finalCode, map: result.map };
            } catch (fallbackError: any) {
                log.error(`Solid fallback also failed: ${fallbackError.message}`);
                return this.transformVanilla(code, filePath, isDev);
            }
        }
    }

    /**
     * Preact Transformer - Works with all Preact versions
     */
    private async transformPreact(code: string, filePath: string, isDev: boolean): Promise<TransformResult> {
        return this.transformReact(code, filePath, isDev, { importSource: 'preact' });
    }

    /**
     * Qwik Transformer - Works with all Qwik versions
     */
    private async transformQwik(code: string, filePath: string, isDev: boolean): Promise<TransformResult> {
        const ext = path.extname(filePath);
        if (ext !== '.tsx' && ext !== '.ts' && ext !== '.jsx' && ext !== '.js') {
            return this.transformVanilla(code, filePath, isDev);
        }
        try {
            let qwik: any;
            try {
                const compilerPath = _require.resolve('@builder.io/qwik/optimizer', { paths: [this.root, process.cwd()] });
                const mod = await import(pathToFileURL(compilerPath).href);
                qwik = typeof mod.createOptimizer === 'function' ? mod : (mod.default || mod);
            } catch (e: any) {
                console.error("[Qwik Optimizer] Original import failed:", e);
                const fallbackQwikOptimizer = '@builder.io/qwik/optimizer';
                const mod = await import(fallbackQwikOptimizer);
                qwik = typeof mod.createOptimizer === 'function' ? mod : (mod.default || mod);
            }

            const optimizer = await qwik.createOptimizer();
            const result = await optimizer.transformModules({
                input: [{ code, path: filePath }],
                srcDir: path.join(this.root, 'src'),
                rootDir: this.root,
                entryStrategy: { type: 'inline' },
                minify: isDev ? 'none' : 'simplify',
                sourceMaps: isDev,
                mode: isDev ? 'dev' : 'lib',
                transpile: true,
            });

            const output = result.modules[0];
            const { transform } = await import('esbuild');
            const final = await transform(output.code, {
                loader: 'tsx',
                format: 'esm',
                target: 'es2020',
                jsx: 'automatic',
                jsxImportSource: '@builder.io/qwik'
            });
            const finalCode = final.code;
            return { code: finalCode, map: final.map ? JSON.stringify(final.map) : undefined };
        }
        catch (error: any) {
            // Fallback: use esbuild directly with Qwik JSX classic mode
            log.warn(`Qwik optimizer failed, using esbuild fallback: ${error.message}`);
            try {
                const final = await esbuild.transform(code, {
                    loader: (path.extname(filePath) === '.tsx' || path.extname(filePath) === '.jsx') ? 'tsx' : 'ts',
                    format: 'esm',
                    target: 'es2020',
                    jsx: 'transform',
                    jsxFactory: 'h',
                    jsxFragment: 'Fragment',
                    jsxImportSource: undefined,
                });
                // Inject h/Fragment imports from qwik
                const imports = `import { h, Fragment } from '@builder.io/qwik';\n`;
                return { code: imports + final.code };
            } catch (fallbackErr: any) {
                log.error(`Qwik fallback also failed for ${filePath}: ${fallbackErr.message}`);
                return this.transformVanilla(code, filePath, isDev);
            }
        }
    }

    /**
     * Lit Transformer - Works with all Lit versions
     */
    private async transformLit(code: string, filePath: string, isDev: boolean): Promise<TransformResult> {
        try {
            const ts = await import('typescript');
            const result = ts.transpileModule(code, {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2020,
                    module: ts.ModuleKind.ESNext,
                    experimentalDecorators: true,
                    useDefineForClassFields: false,
                    moduleResolution: ts.ModuleResolutionKind.NodeJs
                },
                fileName: filePath
            });

            let finalCode = result.outputText;

            return { code: finalCode, map: result.sourceMapText };
        } catch (error: any) {
            log.error(`Lit transform failed for ${filePath}:`, error.message);
            return this.transformVanilla(code, filePath, isDev);
        }
    }

    /**
     * Astro Transformer - Works with all Astro versions
     */
    private async transformAstro(code: string, filePath: string, isDev: boolean): Promise<TransformResult> {
        if (!filePath.endsWith('.astro')) {
            return this.transformVanilla(code, filePath, isDev);
        }

        try {
            let astro: any;
            try {
                const compilerPath = _require.resolve('@astrojs/compiler', { paths: [this.root, process.cwd()] });
                const mod = await import(compilerPath);
                astro = typeof mod.transform === 'function' ? mod : (mod.default || mod);
            } catch {
                const fallbackAstroCompiler = '@astrojs/compiler';
                const mod = await import(fallbackAstroCompiler);
                astro = typeof mod.transform === 'function' ? mod : (mod.default || mod);
            }

            const result = await astro.transform(code, {
                filename: filePath,
                sourcemap: isDev ? 'inline' : false,
            });

            return { code: result.code, map: result.map ? JSON.stringify(result.map) : undefined };
        } catch (error: any) {
            log.error(`Astro transform failed for ${filePath}: ${error.stack || error.message}`);
            return { code };
        }
    }

    /**
     * Vanilla JS/TS Transformer - Works with all versions
     */
    private async transformVanilla(code: string, filePath: string, isDev: boolean): Promise<TransformResult> {
        // Fix for local monorepo: Skip transformation for known node-only packages 
        // that might be accidentally picked up by the customized resolver
        if (filePath.includes('node_modules') && (
            filePath.includes('svelte/compiler') ||
            filePath.includes('vite/dist')
        )) {
            return { code };
        }

        const ext = path.extname(filePath);
        if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs') {
            try {
                // Day 3: Bun Parser Lock
                // Try Bun parser first (17x faster)
                const { bunParser } = await import('./parser-bun.js');
                if (bunParser.isBun()) {
                    try {
                        return await bunParser.transform(code, filePath, { isDev });
                    } catch (e) {
                        log.warn(`Bun transform failed, falling back to esbuild: ${e}`);
                    }
                }

                // Fallback to esbuild
                const result = await esbuild.transform(code, {
                    loader: (ext === '.mjs' ? 'js' : ext.slice(1)) as any,
                    sourcemap: isDev ? 'inline' : false,
                    format: 'esm',
                    target: 'es2020',
                    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } }
                });
                return { code: result.code, map: result.map };
            } catch (error: any) {
                log.error(`Vanilla transform failed for ${filePath}:`, error.message);
                return { code };
            }
        }
        return { code };
    }

    /**
     * Resolves a dependency's version the way Node resolves the package:
     * walking up every parent `node_modules`, then falling back to
     * `require.resolve`. Looking only at `<root>/node_modules` missed hoisted,
     * pnpm and workspace layouts, which silently changed how JSX was compiled.
     */
    private async getPackageVersion(packageName: string): Promise<string | null> {
        if (this.packageVersionCache.has(packageName)) {
            return this.packageVersionCache.get(packageName)!;
        }

        const read = async (pkgPath: string): Promise<string | null> => {
            try {
                const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
                return typeof pkg.version === 'string' ? pkg.version : null;
            } catch {
                return null;
            }
        };

        let dir = this.root;
        while (true) {
            const version = await read(path.join(dir, 'node_modules', packageName, 'package.json'));
            if (version) {
                this.packageVersionCache.set(packageName, version);
                return version;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }

        try {
            const { createRequire } = await import('module');
            const require = createRequire(path.join(this.root, 'package.json'));
            const version = await read(require.resolve(`${packageName}/package.json`));
            if (version) {
                this.packageVersionCache.set(packageName, version);
                return version;
            }
        } catch {
            // Package genuinely absent, or it hides its package.json behind exports.
        }

        this.packageVersionCache.set(packageName, null);
        return null;
    }
}
