/**
 * Resolve a Vite configuration the way Vite does: load vite.config with its
 * real plugins, run `config` hooks, fill in defaults (including the client /
 * ssr environments of Vite 6), run `configResolved`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findViteConfig } from '../config/vite-compat.js';
import { createLogger, type Logger } from './logger.js';
import { corePlugins } from './plugins/index.js';
import { arraify, isObject, loadEnv, mergeConfig, normalizeAlias, normalizePath, searchForWorkspaceRoot, type Alias } from './utils.js';

export type Command = 'serve' | 'build';

export interface InlineConfig extends Record<string, any> {
    root?: string;
    mode?: string;
    configFile?: string | false;
    logLevel?: 'info' | 'warn' | 'error' | 'silent';
}

export interface ConfigEnv {
    command: Command;
    mode: string;
    isSsrBuild: boolean;
    isPreview: boolean;
}

export type ResolvedConfig = Record<string, any> & {
    root: string;
    base: string;
    command: Command;
    mode: string;
    isProduction: boolean;
    plugins: any[];
    logger: Logger;
    env: Record<string, any>;
    resolve: { alias: Alias[]; conditions: string[]; mainFields: string[]; extensions: string[]; dedupe: string[]; preserveSymlinks: boolean };
    environments: Record<string, any>;
};

export const DEFAULT_CLIENT_CONDITIONS = ['module', 'browser', 'development|production'];
export const DEFAULT_SERVER_CONDITIONS = ['module', 'node', 'development|production'];
export const DEFAULT_EXTERNAL_CONDITIONS = ['node'];
export const DEFAULT_CLIENT_MAIN_FIELDS = ['browser', 'module', 'jsnext:main', 'jsnext'];
export const DEFAULT_SERVER_MAIN_FIELDS = ['module', 'jsnext:main', 'jsnext'];
export const DEFAULT_EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];

/** Vite allows nested arrays, falsy entries and promises in `plugins`. */
export async function flattenPlugins(list: unknown): Promise<any[]> {
    const out: any[] = [];
    for (const item of await Promise.all(arraify(list as any))) {
        if (Array.isArray(item)) out.push(...(await flattenPlugins(item)));
        else if (item && typeof item === 'object') out.push(item);
    }
    return out;
}

export function getHookHandler(hook: any): ((...args: any[]) => any) | undefined {
    return typeof hook === 'object' && hook ? hook.handler : hook;
}

/** Plugins with a hook, honouring `order: 'pre' | 'post'`. */
export function sortByHook(plugins: any[], name: string): any[] {
    const pre: any[] = [];
    const normal: any[] = [];
    const post: any[] = [];
    for (const plugin of plugins) {
        const hook = plugin[name];
        if (!hook) continue;
        const order = typeof hook === 'object' ? hook.order : undefined;
        (order === 'pre' ? pre : order === 'post' ? post : normal).push(plugin);
    }
    return [...pre, ...normal, ...post];
}

async function loadConfigFile(root: string, configFile: string | false | undefined, env: ConfigEnv): Promise<{ file?: string; config: Record<string, any> }> {
    if (configFile === false) return { config: {} };
    const file = configFile ? path.resolve(root, configFile) : findViteConfig(root) ? path.join(root, findViteConfig(root)!) : undefined;
    if (!file) return { config: {} };
    const { importBundled } = await import('../lib/load-module.js');
    let config = await importBundled(file, { root, fresh: true });
    if (typeof config === 'function') config = await config(env);
    return { file, config: config ?? {} };
}

function resolveBase(base: string | undefined, isBuild: boolean): string {
    if (!base) return '/';
    if (base === './' || base === '') return isBuild ? './' : '/';
    if (/^https?:\/\//.test(base)) return base.endsWith('/') ? base : base + '/';
    let out = base.startsWith('/') ? base : '/' + base;
    if (!out.endsWith('/')) out += '/';
    return out;
}

function replaceMode(conditions: string[], isProduction: boolean): string[] {
    return conditions.map((c) => (c === 'development|production' ? (isProduction ? 'production' : 'development') : c));
}

export async function resolveConfig(inlineConfig: InlineConfig, command: Command, defaultMode = command === 'build' ? 'production' : 'development', isPreview = false): Promise<ResolvedConfig> {
    let mode = inlineConfig.mode || defaultMode;
    const isNodeEnvSet = !!process.env.NODE_ENV;
    if (!isNodeEnvSet) process.env.NODE_ENV = mode === 'production' ? 'production' : 'development';
    const configEnv: ConfigEnv = { command, mode, isSsrBuild: !!inlineConfig.build?.ssr, isPreview };

    const initialRoot = path.resolve(inlineConfig.root ?? process.cwd());
    const loaded = await loadConfigFile(initialRoot, inlineConfig.configFile, configEnv);
    let config: Record<string, any> = mergeConfig(loaded.config, inlineConfig);
    mode = inlineConfig.mode || config.mode || mode;
    configEnv.mode = mode;

    // Plugins: flatten, filter by `apply`, group by `enforce`.
    const rawPlugins = (await flattenPlugins(config.plugins ?? [])).filter((p) => {
        if (!p.apply) return true;
        if (typeof p.apply === 'function') return p.apply({ ...config, mode }, configEnv);
        return p.apply === command;
    });
    const prePlugins = rawPlugins.filter((p) => p.enforce === 'pre');
    const postPlugins = rawPlugins.filter((p) => p.enforce === 'post');
    const normalPlugins = rawPlugins.filter((p) => p.enforce !== 'pre' && p.enforce !== 'post');
    const userPlugins = [...prePlugins, ...normalPlugins, ...postPlugins];

    // `config` hooks may mutate the config or return a partial one to merge.
    for (const plugin of sortByHook(userPlugins, 'config')) {
        const handler = getHookHandler(plugin.config)!;
        const result = await handler.call({ meta: { viteVersion: '7.1.9', rollupVersion: '4.40.0', watchMode: command === 'serve' } }, config, configEnv);
        if (result) config = mergeConfig(config, result);
    }

    const root = path.resolve(config.root ? path.resolve(initialRoot, config.root) : initialRoot);
    const isProduction = (process.env.NODE_ENV || mode) === 'production' || mode === 'production';
    const isBuild = command === 'build';
    const logger = createLogger(config.logLevel ?? inlineConfig.logLevel, { customLogger: config.customLogger });

    const envDir = config.envDir ? path.resolve(root, config.envDir) : root;
    const envPrefix = arraify(config.envPrefix ?? 'VITE_');
    const userEnv = config.envDir === false ? {} : loadEnv(mode, envDir, envPrefix);
    const base = resolveBase(config.base, isBuild);
    const env: Record<string, any> = {
        ...userEnv,
        BASE_URL: base,
        MODE: mode,
        DEV: !isProduction,
        PROD: isProduction,
    };

    const userResolve = config.resolve ?? {};
    const alias = normalizeAlias(userResolve.alias ?? config.alias ?? []);
    const clientConditions = replaceMode(userResolve.conditions ?? DEFAULT_CLIENT_CONDITIONS, isProduction);
    const serverConditions = replaceMode(config.ssr?.resolve?.conditions ?? userResolve.conditions ?? DEFAULT_SERVER_CONDITIONS, isProduction);
    const resolve = {
        alias,
        conditions: clientConditions,
        mainFields: userResolve.mainFields ?? DEFAULT_CLIENT_MAIN_FIELDS,
        extensions: userResolve.extensions ?? DEFAULT_EXTENSIONS,
        dedupe: userResolve.dedupe ?? [],
        preserveSymlinks: !!userResolve.preserveSymlinks,
        externalConditions: config.ssr?.resolve?.externalConditions ?? DEFAULT_EXTERNAL_CONDITIONS,
    };

    const build = {
        target: 'baseline-widely-available',
        outDir: 'dist',
        assetsDir: 'assets',
        assetsInlineLimit: 4096,
        cssCodeSplit: !config.build?.lib,
        sourcemap: false,
        rollupOptions: {},
        minify: config.build?.ssr ? false : 'oxc',
        write: true,
        emptyOutDir: null,
        copyPublicDir: true,
        manifest: false,
        ssrManifest: false,
        ssrEmitAssets: false,
        reportCompressedSize: true,
        chunkSizeWarningLimit: 500,
        modulePreload: { polyfill: true },
        ssr: false,
        ...config.build,
    };
    build.rollupOptions = build.rolldownOptions = { ...build.rollupOptions, ...build.rolldownOptions };

    const server = {
        port: 5173,
        strictPort: false,
        host: undefined,
        https: undefined,
        open: false,
        hmr: true,
        watch: {},
        preTransformRequests: true,
        middlewareMode: false,
        headers: {},
        proxy: undefined,
        warmup: {},
        ...config.server,
        fs: {
            strict: true,
            deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**'],
            ...config.server?.fs,
            allow: (config.server?.fs?.allow ?? [searchForWorkspaceRoot(root)]).map((p: string) => path.resolve(root, p)),
        },
    };

    const ssr = {
        target: 'node',
        external: [],
        noExternal: [],
        optimizeDeps: {},
        ...config.ssr,
        resolve: { conditions: serverConditions, externalConditions: resolve.externalConditions, ...config.ssr?.resolve },
    };

    const publicDir = config.publicDir === false ? '' : path.resolve(root, config.publicDir ?? 'public');
    const cacheDir = config.cacheDir ? path.resolve(root, config.cacheDir) : path.join(root, 'node_modules', '.vite');

    const environmentDefaults = {
        define: config.define,
        resolve: { ...resolve },
        dev: { warmup: [], preTransformRequests: true, sourcemap: { js: true }, sourcemapIgnoreList: (p: string) => p.includes('node_modules'), createEnvironment: undefined, recoverable: true, moduleRunnerTransform: false },
        build,
        keepProcessEnv: false,
    };
    const userEnvironments: Record<string, any> = { client: {}, ssr: {}, ...config.environments };
    // Vite 6 `configEnvironment`: plugins add per-environment options (resolve.noExternal, conditions…).
    for (const name of Object.keys(userEnvironments)) {
        for (const plugin of sortByHook(userPlugins, 'configEnvironment')) {
            const result = await getHookHandler(plugin.configEnvironment)!.call({}, name, userEnvironments[name], { ...configEnv, isSsrTargetWebworker: false });
            if (result) userEnvironments[name] = mergeConfig(userEnvironments[name], result);
        }
    }
    const environments: Record<string, any> = {};
    const envNames = new Set(['client', 'ssr', ...Object.keys(userEnvironments)]);
    for (const name of envNames) {
        const isClient = name === 'client';
        const user = userEnvironments[name] ?? {};
        environments[name] = mergeConfig(
            {
                ...environmentDefaults,
                consumer: isClient ? 'client' : 'server',
                resolve: isClient
                    ? { ...resolve, noExternal: [], external: [] }
                    : {
                          ...resolve,
                          conditions: serverConditions,
                          mainFields: userResolve.mainFields ?? DEFAULT_SERVER_MAIN_FIELDS,
                          // Vite 6: top-level resolve.(no)External applies to server environments too.
                          noExternal: ssr.noExternal === true || userResolve.noExternal === true ? true : [...arraify(ssr.noExternal ?? []), ...arraify(userResolve.noExternal ?? [])],
                          external: ssr.external === true || userResolve.external === true ? true : [...arraify(ssr.external ?? []), ...arraify(userResolve.external ?? [])],
                      },
                build: { ...build, ssr: !isClient },
                // Vite 6: server environments run modules through the module runner.
                dev: { ...environmentDefaults.dev, moduleRunnerTransform: !isClient },
            },
            user,
        );
        environments[name].consumer = user.consumer ?? (isClient ? 'client' : 'server');
        // rolldown-vite: build.rollupOptions and build.rolldownOptions are one object.
        const envBuild = environments[name].build;
        envBuild.rollupOptions = envBuild.rolldownOptions = { ...envBuild.rollupOptions, ...envBuild.rolldownOptions };
    }

    const assetsIncludeList = arraify(config.assetsInclude ?? []);
    const { createFilter } = await import('./utils.js');
    const assetsPatterns = assetsIncludeList.filter(Boolean);
    const assetsFilter = assetsPatterns.length ? createFilter(assetsPatterns, undefined, { resolve: false }) : () => false;

    const resolved: any = {
        ...config,
        configFile: loaded.file ? normalizePath(loaded.file) : undefined,
        configFileDependencies: loaded.file ? [loaded.file] : [],
        inlineConfig,
        root,
        base,
        decodedBase: decodeURI(base),
        rawBase: config.base ?? '/',
        publicDir,
        cacheDir,
        command,
        mode,
        isWorker: false,
        mainConfig: null,
        bundleChain: [],
        isProduction,
        isBundled: isBuild,
        env,
        envDir,
        envPrefix,
        resolve,
        server,
        preview: { port: 4173, ...config.preview },
        build,
        ssr,
        css: { transformer: 'postcss', ...config.css, modules: config.css?.modules ?? {} },
        json: { namedExports: true, stringify: 'auto', ...config.json },
        esbuild: config.esbuild === false ? false : { jsxDev: !isProduction, ...config.esbuild },
        oxc: config.oxc === false ? false : { ...config.oxc },
        optimizeDeps: { include: [], exclude: [], esbuildOptions: {}, rolldownOptions: {}, ...config.optimizeDeps },
        worker: { format: 'iife', plugins: () => [], rollupOptions: {}, ...config.worker },
        appType: config.appType ?? 'spa',
        experimental: { importGlobRestoreExtension: false, hmrPartialAccept: false, ...config.experimental },
        future: config.future ?? {},
        define: config.define ?? {},
        logger,
        environments,
        assetsInclude: (file: string) => assetsFilter(file),
        createResolver: () => async () => undefined,
        packageCache: new Map(),
        dev: environments.client.dev,
        webSocketToken: Math.random().toString(36).slice(2),
        additionalAllowedHosts: [],
    };

    // The plugin chain, in Vite's order, with lunx's built-ins in place of Vite's.
    resolved.plugins = corePlugins(resolved, { pre: prePlugins, normal: normalPlugins, post: postPlugins });
    resolved.getSortedPlugins = (hook: string) => sortByHook(resolved.plugins, hook);
    resolved.getSortedPluginHooks = (hook: string) => sortByHook(resolved.plugins, hook).map((p) => getHookHandler(p[hook]));

    await Promise.all(sortByHook(resolved.plugins, 'configResolved').map((p) => getHookHandler(p.configResolved)!.call({}, resolved)));
    return resolved as ResolvedConfig;
}

/**
 * The view `this.environment.config` gives plugins: environment options first,
 * then the top-level config.
 */
export function environmentConfig(config: ResolvedConfig, name: string): any {
    const options = config.environments[name] ?? config.environments.ssr;
    return new Proxy(config, {
        get(target, prop) {
            if (prop === 'getTopLevelConfig') return () => config;
            if (typeof prop === 'string' && prop in options) return options[prop];
            return (target as any)[prop];
        },
    });
}

export function isFileReadable(file: string): boolean {
    try {
        fs.accessSync(file, fs.constants.R_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

export { isObject };
