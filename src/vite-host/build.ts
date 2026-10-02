/**
 * `build()`: Vite's build on Rolldown. Resolves the config for `build`, gives
 * every plugin hook `this.environment`, maps Vite's build options onto
 * Rolldown and returns Rollup-shaped output, so a framework that calls
 * `vite.build()` from its own hooks (SvelteKit's client build) works too.
 */

import fs from 'node:fs';
import path from 'node:path';
import { rollupCompatibleBuild } from '../engines/toolkit.js';
import { environmentConfig, resolveConfig, type InlineConfig } from './config.js';
import { arraify, cleanUrl } from './utils.js';

const ROLLUP_HOOKS = new Set([
    'options', 'buildStart', 'resolveId', 'resolveDynamicImport', 'load', 'transform', 'moduleParsed', 'buildEnd',
    'renderStart', 'renderDynamicImport', 'banner', 'footer', 'intro', 'outro', 'augmentChunkHash', 'renderChunk',
    'renderError', 'generateBundle', 'writeBundle', 'closeBundle', 'closeWatcher', 'watchChange', 'resolveFileUrl',
    'resolveImportMeta', 'outputOptions', 'onLog',
]);

const INPUT_KEYS = new Set([
    'input', 'external', 'treeshake', 'preserveEntrySignatures', 'shimMissingExports', 'logLevel', 'onLog', 'onwarn',
    'moduleTypes', 'experimental', 'checks', 'makeAbsoluteExternalsRelative', 'context', 'jsx', 'transform', 'watch',
]);

const OUTPUT_DROP = new Set(['hoistTransitiveImports', 'experimentalMinChunkSize', 'generatedCode', 'interop', 'compact', 'dynamicImportInCjs', 'freeze', 'indent', 'noConflict', 'sanitizeFileName', 'validate', 'experimentalDeepDynamicChunkOptimization', 'manualChunks', 'inlineDynamicImports']);

const JS_LIKE = /\.(m?[jt]sx?|c[jt]s|json)$/;

/** Rolldown infers the module type from the extension; compiled `.svelte`, `.vue`… output is JavaScript. */
function withModuleType(result: any, id: string): any {
    if (result == null || id.startsWith('\0') || JS_LIKE.test(cleanUrl(id)) || !path.extname(cleanUrl(id))) return result;
    if (typeof result === 'string') return { code: result, moduleType: 'js' };
    if (typeof result === 'object' && result.code != null && !result.moduleType) return { ...result, moduleType: 'js' };
    return result;
}

function contextWithEnvironment(ctx: any, environment: any): any {
    return new Proxy(ctx, {
        get(target, prop) {
            if (prop === 'environment') return environment;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function wrapPlugin(plugin: any, environment: any): any {
    const out: any = { name: plugin.name };
    for (const key of Object.keys(plugin)) {
        if (!ROLLUP_HOOKS.has(key)) continue;
        const hook = plugin[key];
        const handler = typeof hook === 'function' ? hook : hook?.handler;
        if (typeof handler !== 'function') {
            out[key] = hook;
            continue;
        }
        const wrapped = function (this: any, ...args: any[]) {
            const result = handler.apply(contextWithEnvironment(this, environment), args);
            if (key !== 'load' && key !== 'transform') return result;
            const id = key === 'load' ? args[0] : args[1];
            return result && typeof result.then === 'function' ? result.then((r: any) => withModuleType(r, id)) : withModuleType(result, id);
        };
        out[key] = typeof hook === 'function' ? wrapped : { ...hook, handler: wrapped };
    }
    return out;
}

function applyToEnvironment(plugins: any[], environment: any): any[] {
    const out: any[] = [];
    for (const plugin of plugins) {
        if (typeof plugin.applyToEnvironment !== 'function') {
            out.push(plugin);
            continue;
        }
        const result = plugin.applyToEnvironment(environment);
        if (result === true) out.push(plugin);
        else if (Array.isArray(result)) out.push(...result.filter(Boolean));
        else if (result && typeof result === 'object') out.push(result);
    }
    return out;
}

function copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(from, to);
        else fs.copyFileSync(from, to);
    }
}

export async function build(inlineConfig: InlineConfig = {}): Promise<any> {
    const config: any = await resolveConfig(inlineConfig, 'build', 'production');
    const ssr = !!config.build.ssr;
    const envName = ssr ? 'ssr' : 'client';
    const environment: any = {
        name: envName,
        mode: 'build',
        config: environmentConfig(config, envName),
        logger: config.logger,
        getTopLevelConfig: () => config,
        isBuilt: false,
    };
    const envConfig = environment.config;
    const root = config.root;
    const outDir = path.resolve(root, config.build.outDir);
    const write = config.build.write !== false;

    const ro = config.build.rollupOptions ?? {};
    let input = ssr && typeof config.build.ssr === 'string' ? config.build.ssr : ro.input;
    if (!input) {
        if (ssr) throw new Error('rollupOptions.input or build.ssr must be set for an SSR build');
        input = path.join(root, 'index.html');
        throw new Error('[lunx] HTML entry builds through the Vite host are not supported yet; use lunx build without vite plugins.');
    }

    if (write && (config.build.emptyOutDir ?? outDir.startsWith(root + path.sep)) && fs.existsSync(outDir)) {
        for (const entry of fs.readdirSync(outDir)) if (entry !== '.git') fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
    }
    if (write && !ssr && config.build.copyPublicDir !== false && config.publicDir && fs.existsSync(config.publicDir)) {
        copyDir(config.publicDir, outDir);
    }

    const env = { ...config.env, SSR: ssr };
    const define: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...config.define, ...envConfig.define })) define[k] = typeof v === 'string' ? v : JSON.stringify(v);
    for (const [k, v] of Object.entries(env)) define[`import.meta.env.${k}`] = JSON.stringify(v);
    define['import.meta.env'] = JSON.stringify(env);
    if (!ssr) define['process.env.NODE_ENV'] ??= JSON.stringify(config.isProduction ? 'production' : 'development');

    const plugins = applyToEnvironment(config.plugins, environment).map((p: any) => wrapPlugin(p, environment));
    const userInput: Record<string, any> = {};
    for (const [k, v] of Object.entries(ro)) if (INPUT_KEYS.has(k) && k !== 'input') userInput[k] = v;
    const resolve = envConfig.resolve ?? config.resolve;
    const inputOptions: Record<string, any> = {
        ...userInput,
        input,
        cwd: root,
        platform: ssr ? 'node' : 'browser',
        plugins,
        resolve: {
            conditionNames: [...resolve.conditions, 'import', 'default'],
            mainFields: [...resolve.mainFields, 'main'],
            extensions: resolve.extensions,
        },
        transform: { ...userInput.transform, define: { ...userInput.transform?.define, ...define } },
        logLevel: config.logLevel === 'silent' ? 'silent' : 'warn',
    };

    const outputs = arraify(ro.output ?? {});
    const assetsDir = config.build.assetsDir;
    const results: any[] = [];
    for (const userOutput of outputs) {
        const output: Record<string, any> = {};
        for (const [k, v] of Object.entries(userOutput as Record<string, any>)) if (!OUTPUT_DROP.has(k)) output[k] = v;
        const inline = (userOutput as any).inlineDynamicImports;
        const outputOptions: Record<string, any> = {
            dir: outDir,
            format: 'es',
            entryFileNames: ssr ? '[name].js' : `${assetsDir}/[name]-[hash].js`,
            chunkFileNames: ssr ? '[name]-[hash].js' : `${assetsDir}/[name]-[hash].js`,
            assetFileNames: `${assetsDir}/[name]-[hash][extname]`,
            minify: !ssr && config.build.minify !== false,
            sourcemap: config.build.sourcemap === true ? true : config.build.sourcemap || false,
            ...output,
            ...(inline ? { codeSplitting: false } : {}),
        };
        if (outputOptions.format === 'esm' || outputOptions.format === 'module') outputOptions.format = 'es';
        const started = Date.now();
        const result = await rollupCompatibleBuild(inputOptions, outputOptions, write);
        config.logger.info(`[lunx] ${envName} build: ${result.output.length} files in ${Date.now() - started}ms → ${path.relative(process.cwd(), outDir) || '.'}`);
        results.push(result);
    }
    environment.isBuilt = true;
    return results.length === 1 ? results[0] : results;
}
