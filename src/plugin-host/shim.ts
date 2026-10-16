/**
 * The `vite` module as framework plugins see it when lunx hosts them:
 * `import { normalizePath, loadEnv, createServer, … } from 'vite'` resolves
 * here (see ./loader.ts), so Vite itself is never loaded.
 */

import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createResolver, oxcTransform } from '../engines/toolkit.js';
import { parse as parseCode } from '../engines/index.js';
import { compileCss, isCssModule } from '../build/css.js';
import { resolveConfig } from './config.js';
import { createLogger } from './logger.js';
import { createServer } from './server.js';
import { arraify, buildErrorMessage, cleanUrl, createFilter, isCSSRequest, loadEnv, mergeConfig, normalizePath, searchForWorkspaceRoot, VERSION } from './utils.js';

export { buildErrorMessage, createFilter, createLogger, createServer, isCSSRequest, loadEnv, mergeConfig, normalizePath, resolveConfig, searchForWorkspaceRoot };

export const version = VERSION;
/** Our builds are Rolldown builds, so plugins pick their rolldown-vite code paths. */
export const rolldownVersion = '1.2.12';
export const esbuildVersion = undefined;

export const defaultClientConditions = ['module', 'browser', 'development|production'];
export const defaultServerConditions = ['module', 'node', 'development|production'];
export const defaultClientMainFields = ['browser', 'module', 'jsnext:main', 'jsnext'];
export const defaultServerMainFields = ['module', 'jsnext:main', 'jsnext'];
export const defaultExternalConditions = ['node'];
export const defaultAllowedOrigins = /^https?:\/\/(?:(?:[^:]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

export function defineConfig(config: any): any {
    return config;
}

export function mergeAlias(a: any, b: any): any {
    return mergeConfig({ resolve: { alias: a } }, { resolve: { alias: b } }).resolve.alias;
}

export async function loadConfigFromFile(env: any, configFile?: string, configRoot = process.cwd()): Promise<any> {
    const { findViteConfig } = await import('../config/vite-compat.js');
    const name = configFile ?? findViteConfig(configRoot);
    if (!name) return null;
    const file = path.resolve(configRoot, name);
    const { importBundled } = await import('../lib/load-module.js');
    let config = await importBundled(file, { root: configRoot });
    if (typeof config === 'function') config = await config(env);
    return { path: normalizePath(file), config: config ?? {}, dependencies: [file] };
}

export async function transformWithOxc(code: string, filename: string, options: Record<string, any> = {}): Promise<{ code: string; map: any; warnings: any[] }> {
    const lang = options.lang ?? (/\.tsx$/.test(filename) ? 'tsx' : /\.[cm]?ts$/.test(filename) ? 'ts' : /\.jsx$/.test(filename) ? 'jsx' : 'js');
    const result = await oxcTransform(filename, code, {
        sourcemap: true,
        ...options,
        lang,
        typescript: { onlyRemoveTypeImports: true, ...options.typescript },
    });
    if (result.errors.length) {
        const err: any = new Error(result.errors.map((e: any) => e.message ?? String(e)).join('\n'));
        err.id = filename;
        throw err;
    }
    return { code: result.code, map: result.map, warnings: result.warnings };
}

/** esbuild-shaped options mapped onto Oxc. */
export async function transformWithEsbuild(code: string, filename: string, options: Record<string, any> = {}): Promise<{ code: string; map: any; warnings: any[] }> {
    const jsx = options.jsx === 'preserve' ? 'preserve' : options.jsx ? { runtime: options.jsx === 'automatic' ? 'automatic' : 'classic', importSource: options.jsxImportSource, pragma: options.jsxFactory, pragmaFrag: options.jsxFragment, development: !!options.jsxDev } : undefined;
    return transformWithOxc(code, filename, {
        lang: options.loader && options.loader !== 'js' ? options.loader : undefined,
        jsx,
        define: options.define,
        target: typeof options.target === 'string' ? options.target : undefined,
    });
}

export async function preprocessCSS(code: string, filename: string, config: any): Promise<{ code: string; map?: any; modules?: Record<string, string>; deps?: Set<string> }> {
    const file = cleanUrl(filename);
    const result = await compileCss({
        root: config.root ?? process.cwd(),
        file: /\.(css|pcss|postcss|scss|sass|less|styl|stylus)$/i.test(file) ? file : file.replace(/\.[^.]*$/, '') + '.css',
        source: code,
        modules: isCssModule(file),
        minify: false,
        resolveUrl: (_from, url) => url,
    });
    return { code: result.code, modules: result.exports, deps: new Set(result.dependencies.filter((d) => d !== file)) };
}

/** rolldown-vite's Oxc `parse` / `parseSync`: { program, errors, comments }. */
export function parseSync(filename: string, code: string, options?: { lang?: 'js' | 'jsx' | 'ts' | 'tsx' }): any {
    return { program: parseCode(filename, code, options?.lang), errors: [], comments: [], module: { staticImports: [], staticExports: [], dynamicImports: [] } };
}

export async function parse(filename: string, code: string, options?: { lang?: 'js' | 'jsx' | 'ts' | 'tsx' }): Promise<any> {
    return parseSync(filename, code, options);
}

/** Rollup's parseAst: an ESTree program. */
export function parseAst(code: string, options?: { jsx?: boolean }): any {
    return parseCode(options?.jsx ? 'module.jsx' : 'module.js', code, options?.jsx ? 'jsx' : 'js');
}

export async function parseAstAsync(code: string, options?: { jsx?: boolean }): Promise<any> {
    return parseAst(code, options);
}

/** Vite 7 `runnerImport`: evaluate a (config) module with its imports bundled. */
export async function runnerImport(moduleId: string, inlineConfig: any = {}): Promise<{ module: any; dependencies: string[] }> {
    const { importBundled } = await import('../lib/load-module.js');
    const root = inlineConfig.root ?? process.cwd();
    const file = path.resolve(root, moduleId);
    return { module: await importBundled(file, { root, fresh: true, namespace: true }), dependencies: [file] };
}

export async function formatPostcssSourceMap(map: any): Promise<any> {
    return map;
}

export function send(req: any, res: any, content: string | Buffer, type: string, options: { etag?: string; cacheControl?: string; headers?: Record<string, any> } = {}): void {
    if (options.etag && req.headers['if-none-match'] === options.etag) {
        res.statusCode = 304;
        res.end();
        return;
    }
    res.setHeader('Content-Type', type === 'js' ? 'text/javascript' : type === 'css' ? 'text/css' : type === 'html' ? 'text/html' : type);
    res.setHeader('Cache-Control', options.cacheControl ?? 'no-cache');
    if (options.etag) res.setHeader('Etag', options.etag);
    for (const [k, v] of Object.entries(options.headers ?? {})) res.setHeader(k, v);
    res.statusCode = 200;
    res.end(content);
}

/**
 * Vite's `fetchModule(environment, url, importer, options)`: what a module runner
 * (Vitest's, a framework's) gets for a module. Builtins, URLs and bare imports run
 * natively in Node (externalized, by Node's resolution); everything else comes back
 * transformed for the runner, with its source map inlined.
 */
export async function fetchModule(environment: any, url: string, importer?: string, options: { cached?: boolean; inlineSourceMap?: boolean; startOffset?: number } = {}): Promise<any> {
    if (url.startsWith('data:') || url.startsWith('node:') || builtinModules.includes(url)) return { externalize: url, type: 'builtin' };
    const isFileUrl = url.startsWith('file://');
    if (/^(https?:)?\/\//.test(url) && !isFileUrl) return { externalize: url, type: 'network' };
    if (!isFileUrl && importer && url[0] !== '.' && url[0] !== '/' && !url.startsWith('\0') && !url.startsWith('virtual:')) {
        const conditions: string[] = (environment.config?.resolve?.externalConditions ?? []).concat(['node', 'import', 'module', 'default']);
        const resolver = createResolver({ conditionNames: [...new Set<string>(conditions)], mainFields: ['module', 'main'], extensions: ['.mjs', '.js', '.cjs', '.json', '.node'] });
        const from = path.dirname(cleanUrl(importer.startsWith('file://') ? fileURLToPath(importer) : importer));
        const resolved = resolver.resolve(from, url);
        if (!resolved) throw new Error(`Cannot find module '${url}' imported from '${importer}'`);
        return { externalize: pathToFileURL(resolved).href, type: isModuleFile(resolved) ? 'module' : 'commonjs' };
    }
    if (isFileUrl) url = fileURLToPath(url);
    url = url.replace(/^\/@id\/__x00__/, '\0').replace(/^\/@id\//, '');
    const mod = await environment.moduleGraph.ensureEntryFromUrl(url);
    const cached = !!mod.transformResult;
    if (options.cached && cached) return { cache: true };
    const result = await environment.transformRequest(url);
    if (!result) throw new Error(`[vite] transform failed for module '${url}'`);
    let code: string = result.code;
    if (options.inlineSourceMap !== false && result.map) {
        const map = typeof result.map === 'string' ? JSON.parse(result.map) : { ...result.map };
        if (options.startOffset) map.mappings = ';'.repeat(options.startOffset) + map.mappings;
        code = `${code.replace(/\n\/\/# sourceMappingURL=.*$/m, '')}\n//# sourceMappingSource=vite-generated\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    }
    if (code[0] === '#') code = code.replace(/^#!.*/, (line) => ' '.repeat(line.length));
    return { code, file: mod.file, id: mod.id, url: mod.url, invalidate: !cached };
}

/** Whether Node loads `file` as an ES module (.mjs, or "type": "module" in its package). */
function isModuleFile(file: string): boolean {
    if (file.endsWith('.mjs')) return true;
    if (file.endsWith('.cjs') || !file.endsWith('.js')) return false;
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
        const manifest = path.join(dir, 'package.json');
        if (fs.existsSync(manifest)) {
            try {
                return JSON.parse(fs.readFileSync(manifest, 'utf8')).type === 'module';
            } catch {
                return false;
            }
        }
        if (path.dirname(dir) === dir) return false;
    }
}

export function isRunnableDevEnvironment(env: any): boolean {
    return !!env && typeof env.ssrLoadModule === 'function' && !env.isClient;
}

export function isFetchableDevEnvironment(): boolean {
    return false;
}

/** A minimal ModuleRunner over an environment's ssrLoadModule. */
export function createServerModuleRunner(env: any): any {
    return {
        import: (url: string) => env.ssrLoadModule(url),
        clearCache: () => env.moduleGraph.invalidateAll(),
        close: async () => {},
        isClosed: () => false,
    };
}

export function perEnvironmentPlugin(name: string, factory: (env: any) => any): any {
    return { name, applyToEnvironment: factory };
}

export function perEnvironmentState<T>(init: (env: any) => T): (ctx: { environment: any }) => T {
    const states = new WeakMap<object, T>();
    return (ctx) => {
        let state = states.get(ctx.environment);
        if (state === undefined) states.set(ctx.environment, (state = init(ctx.environment)));
        return state;
    };
}

export function createIdResolver(config: any): (env: any, id: string, importer?: string) => Promise<string | undefined> {
    return async (env, id, importer) => (await env.pluginContainer.resolveId(id, importer))?.id;
}

export function isFileServingAllowed(configOrServer: any, file: string): boolean {
    const config = configOrServer.config ?? configOrServer;
    return config.server?.fs?.strict === false || arraify(config.server?.fs?.allow ?? []).some((dir: string) => file.startsWith(dir));
}

export function isFileLoadingAllowed(config: any, file: string): boolean {
    return isFileServingAllowed(config, file);
}

export async function build(inlineConfig: any = {}): Promise<any> {
    const { build: run } = await import('./build.js');
    return run(inlineConfig);
}

export async function preview(): Promise<never> {
    throw new Error('[lunx] vite.preview() under lunx is not implemented yet');
}

export async function createBuilder(inlineConfig: any = {}): Promise<any> {
    const { createBuilder: create } = await import('./build.js');
    return create(inlineConfig);
}

export async function optimizeDeps(): Promise<void> {}

export function sortUserPlugins(plugins: any[]): [any[], any[], any[]] {
    return [plugins.filter((p) => p?.enforce === 'pre'), plugins.filter((p) => p && !p.enforce), plugins.filter((p) => p?.enforce === 'post')];
}

export default {
    version,
    rolldownVersion,
    normalizePath,
    loadEnv,
    mergeConfig,
    defineConfig,
    createServer,
    resolveConfig,
    createLogger,
    createFilter,
    searchForWorkspaceRoot,
    isCSSRequest,
    transformWithOxc,
    transformWithEsbuild,
    preprocessCSS,
    build,
    preview,
};
