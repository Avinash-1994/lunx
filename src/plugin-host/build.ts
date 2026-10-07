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

/**
 * Rolldown hands each plugin fresh chunk objects, so Vite's `chunk.viteMetadata`
 * (importedCss / importedAssets) is attached to the chunks every hook receives.
 */
function decorateArgs(hook: string, args: any[], decorate: (chunk: any) => void): void {
    if (hook === 'renderChunk' || hook === 'augmentChunkHash') decorate(hook === 'renderChunk' ? args[1] : args[0]);
    else if (hook === 'generateBundle' || hook === 'writeBundle') for (const item of Object.values(args[1] ?? {})) decorate(item);
}

/**
 * Rollup lets generateBundle add files by assigning into `bundle` (VitePress's
 * .lean.js pages); Rolldown ignores that. Collect the assignments and emit them.
 */
async function generateBundleWithAssignments(ctx: any, handler: (...a: any[]) => any, environment: any, args: any[]): Promise<void> {
    const bundle = args[1];
    const added = new Map<string, any>();
    const proxy = new Proxy(bundle, {
        get: (target, prop) => (typeof prop === 'string' && added.has(prop) ? added.get(prop) : Reflect.get(target, prop)),
        set: (target, prop, value) => {
            if (typeof prop === 'string' && !(prop in target)) {
                added.set(prop, value);
                return true;
            }
            return Reflect.set(target, prop, value);
        },
        has: (target, prop) => (typeof prop === 'string' && added.has(prop)) || Reflect.has(target, prop),
        deleteProperty: (target, prop) => (typeof prop === 'string' && added.delete(prop)) || Reflect.deleteProperty(target, prop),
        ownKeys: (target) => [...Reflect.ownKeys(target), ...added.keys()],
        getOwnPropertyDescriptor: (target, prop) =>
            typeof prop === 'string' && added.has(prop) ? { value: added.get(prop), enumerable: true, configurable: true, writable: true } : Reflect.getOwnPropertyDescriptor(target, prop),
    });
    await handler.apply(contextWithEnvironment(ctx, environment), [args[0], proxy, ...args.slice(2)]);
    for (const [name, item] of added) {
        const source = item?.code ?? item?.source;
        if (source == null) continue;
        ctx.emitFile({ type: 'asset', fileName: item.fileName ?? name, source });
    }
}

/** Hook argument that carries Vite's options object (`{ ssr }` for resolveId / load / transform). */
const OPTIONS_ARG: Record<string, number> = { resolveId: 2, load: 1, transform: 2 };

function wrapPlugin(plugin: any, environment: any, decorate: (chunk: any) => void = () => {}): any {
    const out: any = { name: plugin.name };
    const ssr = environment.config?.consumer === 'server';
    for (const key of Object.keys(plugin)) {
        if (!ROLLUP_HOOKS.has(key)) continue;
        const hook = plugin[key];
        const handler = typeof hook === 'function' ? hook : hook?.handler;
        if (typeof handler !== 'function') {
            out[key] = hook;
            continue;
        }
        const wrapped = function (this: any, ...args: any[]) {
            decorateArgs(key, args, decorate);
            const optionsAt = OPTIONS_ARG[key];
            if (optionsAt !== undefined) args[optionsAt] = { ...args[optionsAt], ssr };
            if (key === 'generateBundle') return generateBundleWithAssignments(this, handler, environment, args);
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

function makeEnvironment(config: any, name: string): any {
    return {
        name,
        mode: 'build',
        config: environmentConfig(config, name),
        logger: config.logger,
        getTopLevelConfig: () => config,
        isBuilt: false,
    };
}

/** `vite build`: one environment (client, or ssr with build.ssr). */
export async function build(inlineConfig: InlineConfig = {}): Promise<any> {
    const config: any = await resolveConfig(inlineConfig, 'build', 'production');
    return buildEnvironment(config, makeEnvironment(config, config.build.ssr ? 'ssr' : 'client'));
}

/** Vite 6 `createBuilder()`: every environment, orchestrated by `builder.buildApp` when a plugin sets it. */
export async function createBuilder(inlineConfig: InlineConfig = {}): Promise<any> {
    const config: any = await resolveConfig(inlineConfig, 'build', 'production');
    const environments: Record<string, any> = {};
    for (const name of Object.keys(config.environments)) environments[name] = makeEnvironment(config, name);
    const builder: any = {
        config,
        environments,
        build: (environment: any) => buildEnvironment(config, environment),
        async buildApp() {
            for (const plugin of config.plugins) {
                const hook = plugin.buildApp;
                const handler = typeof hook === 'function' ? hook : hook?.handler;
                if (handler) await handler.call({}, builder);
            }
            if (config.builder?.buildApp) return config.builder.buildApp(builder);
            if (config.builder) {
                for (const environment of Object.values(environments)) if (!environment.isBuilt) await builder.build(environment);
                return;
            }
            const single = environments[config.build.ssr ? 'ssr' : 'client'];
            if (!single.isBuilt) await builder.build(single);
        },
    };
    return builder;
}

/** Build one environment of a resolved config on Rolldown. */
export async function buildEnvironment(config: any, environment: any): Promise<any> {
    const envConfig = environment.config;
    const buildOptions = envConfig.build ?? config.build;
    const ssr = environment.config.consumer === 'server' || !!buildOptions.ssr;
    const envName = environment.name;
    config._lunxBuildStates?.delete(envName);
    const root = config.root;
    const outDir = path.resolve(root, buildOptions.outDir);
    const write = buildOptions.write !== false;

    // rolldown-vite's name and Rollup's: plugins that detect Rolldown set rolldownOptions.
    const ro = { ...buildOptions.rollupOptions, ...buildOptions.rolldownOptions };
    let input = ssr && typeof buildOptions.ssr === 'string' ? buildOptions.ssr : ro.input;
    if (!input) {
        if (ssr) throw new Error('rollupOptions.input or build.ssr must be set for an SSR build');
        input = path.join(root, 'index.html');
    }

    if (write && (buildOptions.emptyOutDir ?? outDir.startsWith(root + path.sep)) && fs.existsSync(outDir)) {
        for (const entry of fs.readdirSync(outDir)) if (entry !== '.git') fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
    }
    if (write && !ssr && buildOptions.copyPublicDir !== false && config.publicDir && fs.existsSync(config.publicDir)) {
        copyDir(config.publicDir, outDir);
    }

    const env = { ...config.env, SSR: ssr };
    const define: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...config.define, ...envConfig.define })) define[k] = typeof v === 'string' ? v : JSON.stringify(v);
    for (const [k, v] of Object.entries(env)) define[`import.meta.env.${k}`] = JSON.stringify(v);
    define['import.meta.env'] = JSON.stringify(env);
    if (!ssr) define['process.env.NODE_ENV'] ??= JSON.stringify(config.isProduction ? 'production' : 'development');

    const decorate = (chunk: any) => {
        const state = config._lunxBuildStates?.get(envName);
        if (!state || !chunk || !Array.isArray(chunk.moduleIds)) return;
        try {
            Object.defineProperty(chunk, 'viteMetadata', { value: state.metaFor(chunk), configurable: true, writable: true, enumerable: false });
        } catch {
            /* frozen */
        }
    };
    const plugins = applyToEnvironment(config.plugins, environment).map((p: any) => wrapPlugin(p, environment, decorate));
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
    const assetsDir = buildOptions.assetsDir;
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
            minify: !ssr && buildOptions.minify !== false,
            ...(!ssr && buildOptions.minify !== false ? { comments: { legal: true, annotation: false, jsdoc: false } } : {}),
            sourcemap: buildOptions.sourcemap === true ? true : buildOptions.sourcemap || false,
            ...output,
            ...(inline ? { codeSplitting: false } : {}),
        };
        if (outputOptions.format === 'esm' || outputOptions.format === 'module') outputOptions.format = 'es';
        const started = Date.now();
        const result = await rollupCompatibleBuild(inputOptions, outputOptions, write);
        for (const item of result.output) decorate(item);
        config.logger.info(`[lunx] ${envName} build: ${result.output.length} files in ${Date.now() - started}ms → ${path.relative(process.cwd(), outDir) || '.'}`);
        results.push(result);
    }
    environment.isBuilt = true;
    return results.length === 1 ? results[0] : results;
}
