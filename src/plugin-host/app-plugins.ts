/**
 * Vite plugins in lunx's own app pipeline (`lunx build` / `lunx dev` on an
 * app rather than a framework project). lunx's compilers stand in for the
 * framework plugins; every other plugin gets the lifecycle Vite gives it:
 * `apply` and `enforce`, `config` and `configResolved` with a resolved
 * config, `this.environment`, `transformIndexHtml`, and `writeBundle` /
 * `closeBundle` once the whole app (pages, CSS, public/) is on disk.
 */

import { contextWithEnvironment, makeEnvironment, wrapPlugin } from './build.js';
import { getHookHandler, resolveConfig, sortByHook, type Command, type ResolvedConfig } from './config.js';
import { passesFilter } from './plugin-container.js';
import { applyHooks, indexHtmlHooks } from './plugins/html.js';
import { cleanUrl, VERSION } from './utils.js';

export interface AppPlugins {
    /** What `configResolved` received. */
    config: ResolvedConfig;
    /** The user config after the plugins' `config` hooks, before defaults. */
    userConfig: Record<string, any>;
    /** After `apply`, in `enforce` order. */
    plugins: any[];
    pre: any[];
    normal: any[];
    post: any[];
    environment: any;
}

/** Hooks Rolldown would call before lunx has written the pages, CSS and public/: lunx calls them after. */
const AFTER_WRITE = ['writeBundle', 'closeBundle'] as const;

export async function resolveAppPlugins(root: string, userConfig: Record<string, any>, plugins: any[], command: Command, mode: string): Promise<AppPlugins> {
    const config: any = await resolveConfig({ ...userConfig, root, mode, configFile: false, plugins }, command, mode);
    const list: any[] = config.userPlugins;
    return {
        config,
        userConfig: config.userConfig,
        plugins: list,
        pre: list.filter((p) => p.enforce === 'pre'),
        normal: list.filter((p) => p.enforce !== 'pre' && p.enforce !== 'post'),
        post: list.filter((p) => p.enforce === 'post'),
        environment: makeEnvironment(config, 'client'),
    };
}

/** Stylesheets lunx compiles itself: plugins transform them through `transformCss`. */
const CSS_FILE = /\.(css|pcss|postcss|scss|sass|less|styl|stylus)$/;
export const isStylesheet = (id: string): boolean => CSS_FILE.test(cleanUrl(id)) || /[?&]lunx-component\.css$/.test(id);

export interface LunxCss {
    /** A stylesheet a plugin loads, compiled by lunx's CSS as Vite's CSS plugin would take it. */
    load(ctx: any, id: string, code: string): Promise<any>;
    /** The stylesheets a chunk's modules import: lunx extracts them, so they are not among its modules. */
    of(ctx: any, chunk: any): string[];
}

/** Plugins as Rolldown takes them: Rollup hooks with Vite's `this.environment` and `{ ssr }`. */
export function forRolldown(app: AppPlugins, plugins: any[], css?: LunxCss): any[] {
    return plugins.map((plugin) => {
        const wrapped = wrapPlugin(plugin, app.environment);
        for (const hook of AFTER_WRITE) delete wrapped[hook];
        // In Vite a chunk's modules include its stylesheets (UnoCSS finds its layers there).
        const render = wrapped.renderChunk;
        const renderHandler = getHookHandler(render);
        if (renderHandler && css) {
            const withStylesheets = function (this: any, code: string, chunk: any, ...rest: any[]) {
                const extra = css.of(this, chunk).filter((id) => !(id in chunk.modules));
                if (!extra.length) return renderHandler.call(this, code, chunk, ...rest);
                const modules = { ...chunk.modules };
                for (const id of extra) modules[id] = { code: null, originalLength: 0, renderedLength: 0, removedExports: [], renderedExports: [] };
                const view = new Proxy(chunk, { get: (target, prop) => (prop === 'modules' ? modules : Reflect.get(target, prop, target)) });
                return renderHandler.call(this, code, view, ...rest);
            };
            wrapped.renderChunk = typeof render === 'function' ? withStylesheets : { ...render, handler: withStylesheets };
        }
        const load = wrapped.load;
        const loadHandler = getHookHandler(load);
        if (loadHandler && css) {
            const loadCss = async function (this: any, id: string, ...rest: any[]) {
                const result = await loadHandler.call(this, id, ...rest);
                const code = typeof result === 'string' ? result : result?.code;
                return code != null && isStylesheet(id) ? css.load(this, id, code) : result;
            };
            wrapped.load = typeof load === 'function' ? loadCss : { ...load, handler: loadCss };
        }
        // A stylesheet reaches Rolldown as the JavaScript lunx made of it; its CSS went through transformCss.
        const transform = wrapped.transform;
        const handler = getHookHandler(transform);
        if (handler) {
            const skipCss = function (this: any, code: string, id: string, ...rest: any[]) {
                return isStylesheet(id) ? null : handler.call(this, code, id, ...rest);
            };
            wrapped.transform = typeof transform === 'function' ? skipCss : { ...transform, handler: skipCss };
        }
        return wrapped;
    });
}

/**
 * The plugins' `transform` hooks on a stylesheet, as Vite orders them around
 * its CSS compiler: `'pre'` (enforce: 'pre') on the source, `'post'` (the
 * rest) on the compiled CSS.
 */
export async function transformCss(app: AppPlugins, phase: 'pre' | 'post', ctx: any, code: string, id: string): Promise<string> {
    const plugins = phase === 'pre' ? app.pre : [...app.normal, ...app.post];
    for (const plugin of sortByHook(plugins, 'transform')) {
        const hook = plugin.transform;
        if (!passesFilter(hook, id, code)) continue;
        const result = await getHookHandler(hook)!.call(contextWithEnvironment(ctx, app.environment), code, id, { ssr: false });
        if (typeof result === 'string') code = result;
        else if (result?.code != null) code = result.code;
    }
    return code;
}

/** `transformIndexHtml`: `'pre'` on the source page, `'post'` (everything else) on the built one. */
export function transformIndexHtml(app: AppPlugins, phase: 'pre' | 'post', html: string, ctx: Record<string, any>): Promise<string> {
    const hooks = indexHtmlHooks(app.plugins, phase);
    return hooks.length ? applyHooks(hooks, html, ctx) : Promise.resolve(html);
}

export interface WrittenFile {
    fileName: string;
    type: 'chunk' | 'asset';
    source?: string | Uint8Array;
    code?: string;
    [key: string]: any;
}

/** `writeBundle` then `closeBundle`, with every file of the app written. */
export async function runAfterWrite(app: AppPlugins, outDir: string, files: WrittenFile[]): Promise<void> {
    const plugins = app.plugins.filter((p) => AFTER_WRITE.some((hook) => p[hook]));
    if (!plugins.length) return;
    const bundle: Record<string, any> = {};
    for (const file of files) {
        bundle[file.fileName] = file.type === 'chunk'
            ? file
            : { name: undefined, names: [], originalFileName: null, originalFileNames: [], needsCodeReference: false, ...file, type: 'asset' };
    }
    const outputOptions = { dir: outDir, format: 'es', entryFileNames: 'assets/[name].[hash].js', chunkFileNames: 'assets/[name].[hash].js', assetFileNames: 'assets/[name].[hash][extname]' };
    for (const hook of AFTER_WRITE) {
        for (const plugin of sortByHook(plugins, hook)) {
            const handler = getHookHandler(plugin[hook])!;
            await handler.call(context(app, plugin), ...(hook === 'writeBundle' ? [outputOptions, bundle] : []));
        }
    }
}

function context(app: AppPlugins, plugin: any): any {
    const logger = app.config.logger;
    const say = (level: 'info' | 'warn') => (message: any) => logger[level](`[plugin ${plugin.name}] ${typeof message === 'string' ? message : message?.message}`);
    return {
        environment: app.environment,
        meta: { rollupVersion: '4.40.0', viteVersion: VERSION, watchMode: false },
        warn: say('warn'),
        info: say('info'),
        debug() {},
        error(e: any): never {
            const err: any = typeof e === 'string' ? new Error(e) : e;
            err.plugin = plugin.name;
            throw err;
        },
        emitFile() {
            throw new Error(`[plugin ${plugin.name}] emitFile() is not available once the bundle is written`);
        },
        getModuleInfo: () => null,
        getModuleIds: () => [][Symbol.iterator](),
        resolve: async () => null,
        addWatchFile() {},
        getWatchFiles: () => [],
    };
}
