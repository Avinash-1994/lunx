/**
 * The `vite` module as framework plugins see it when lunx hosts them:
 * `import { normalizePath, loadEnv, createServer, … } from 'vite'` resolves
 * here (see ./loader.ts), so Vite itself is never loaded.
 */

import path from 'node:path';
import { oxcTransform } from '../engines/toolkit.js';
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
