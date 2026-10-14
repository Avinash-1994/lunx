/**
 * The dev half of app-plugins: an app's Vite plugins on lunx's own dev
 * server. They get the `ViteDevServer` `configureServer` expects
 * (middlewares, hot, watcher, module graph, transformIndexHtml), and lunx
 * asks them about the modules it serves: `resolveId` for each import,
 * `load` for each request (virtual modules, `?react`-style queries), and
 * `transform` around its own compilers — `enforce: 'pre'` plugins on the
 * source, the rest on the compiled output, as in Vite.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { resolveAppPlugins, transformIndexHtml, type AppPlugins } from './app-plugins.js';
import { getHookHandler, sortByHook } from './config.js';
import { createConnect, type Connect } from './connect.js';
import { DevEnvironment, type HotChannel } from './environment.js';
import { PluginContainer } from './plugin-container.js';
import { cleanUrl } from './utils.js';

/** Vite's URL for a module that is not a file: `/@id/` + id, with `\0` spelled `__x00__`. */
const ID_PREFIX = '/@id/';
const NULL_BYTE = '__x00__';
const idToUrl = (id: string) => ID_PREFIX + id.replace(/\0/g, NULL_BYTE);
const urlToId = (url: string) => decodeURIComponent(url.slice(ID_PREFIX.length)).split(NULL_BYTE).join('\0');
/** lunx marks CSS, JSON and assets imported from JavaScript with `import`; plugins see the id without it, as in Vite. */
const stripImportQuery = (url: string) => url.replace(/([?&])import(?:&|$)/, '$1').replace(/[?&]$/, '');
const stripTimestamp = (url: string) => url.replace(/([?&])t=\d+&?/, '$1').replace(/[?&]$/, '');
/** Assets: a module only when imported (`?import`); the file itself otherwise (the `.wasm` a module fetches). */
const ASSET = /\.(json|html?|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|flac|aac|m4a|pdf|txt|wasm)$/i;
/** Files lunx serves itself; any other kind (`.mdx`, `.frag`…) is a module only if a plugin's transform makes it one. */
const LUNX_SERVES = /\.(m?[jt]sx?|c[jt]s|vue|svelte|astro|css|pcss|postcss|scss|sass|less|styl|stylus|json|html?|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|flac|aac|m4a|pdf|txt|wasm)$/i;

export interface AppDevHost {
    httpServer: any;
    port: number;
    /** A Vite HMR payload for the page: `{ type: 'full-reload' }`, `{ type: 'custom', event, data }`. */
    send(payload: any): void;
}

export interface AppDev {
    app: AppPlugins;
    /** The plugins' middlewares (`configureServer`); true when one of them answered. */
    handle(req: any, res: any): Promise<boolean>;
    /** Middlewares added by the functions `configureServer` returned: after lunx's own modules, before its page. */
    handleLate(req: any, res: any): Promise<boolean>;
    /** The URL to import `specifier` from when a plugin resolves it (a virtual module, an alias); null leaves it to lunx. */
    resolveImport(specifier: string, importer: string): Promise<string | null>;
    /**
     * A module a plugin loads for this URL, through the `'pre'` transforms (all of them when `transformed`);
     * null when no plugin makes a module of it.
     */
    load(url: string): Promise<{ id: string; code: string; transformed?: boolean } | null>;
    transform(phase: 'pre' | 'post', code: string, id: string): Promise<string>;
    indexHtml(url: string, html: string): Promise<string>;
    /** Tell the plugins; returns the files whose plugin output depends on this one, to update with it. */
    fileChanged(file: string): string[];
    setHttpServer(server: any): void;
    close(): Promise<void>;
}

export async function startAppDev(root: string, viteConfig: Record<string, any>, plugins: any[], mode: string, host: AppDevHost): Promise<AppDev> {
    const app = await resolveAppPlugins(root, viteConfig, plugins, 'serve', mode);
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const hot: HotChannel = {
        send(payload: any, data?: any) {
            host.send(typeof payload === 'string' ? { type: 'custom', event: payload, data } : payload);
        },
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(fn);
        },
        off(event, fn) {
            listeners.get(event)?.delete(fn);
        },
        listen() {},
        close() {},
    };
    const env = new DevEnvironment('client', app.config, hot, app.plugins);
    const watcher: any = Object.assign(new EventEmitter(), {
        add: () => watcher,
        unwatch: () => watcher,
        close: async () => {},
        getWatched: () => ({}),
    });
    env.watcher = watcher;
    const pre = new PluginContainer(env, app.pre);
    const rest = new PluginContainer(env, [...app.normal, ...app.post]);
    // file → modules whose plugin output depends on it (Tailwind's stylesheet on every source it scanned).
    const dependents = new Map<string, Set<string>>();
    const track = (file: string, id?: string) => {
        if (!id) return;
        const key = path.resolve(root, file);
        if (!dependents.has(key)) dependents.set(key, new Set());
        dependents.get(key)!.add(cleanUrl(id));
    };
    for (const container of [env.pluginContainer, pre, rest]) container.onWatchFile = track;
    const hasTransform = (c: PluginContainer) => c.plugins.some((p) => p.transform);
    const transforms = { pre: hasTransform(pre) ? pre : null, post: hasTransform(rest) ? rest : null };
    const loads = app.plugins.some((p) => p.load);
    const resolves = app.plugins.some((p) => p.resolveId);

    const indexHtml = async (url: string, html: string) => {
        const ctx = { path: url, filename: path.join(root, cleanUrl(url) === '/' ? 'index.html' : cleanUrl(url)), server, originalUrl: url };
        return transformIndexHtml(app, 'post', await transformIndexHtml(app, 'pre', html, ctx), ctx);
    };

    const load = async (rawUrl: string): Promise<{ id: string; code: string; transformed?: boolean } | null> => {
        if (!rawUrl.startsWith(ID_PREFIX) && ASSET.test(rawUrl.split('?')[0]!) && !/[?&]import(?:&|$)/.test(rawUrl)) return null;
        const url = stripTimestamp(stripImportQuery(rawUrl));
        const other = !url.startsWith(ID_PREFIX) && !LUNX_SERVES.test(url.split('?')[0]!) && path.extname(url.split('?')[0]!) !== '';
        if (!loads && !other && !url.startsWith(ID_PREFIX)) return null;
        let id: string;
        if (url.startsWith(ID_PREFIX)) id = urlToId(url);
        else {
            const [pathname, query] = url.split('?', 2) as [string, string | undefined];
            const file = pathname.startsWith('/@fs/') ? '/' + pathname.slice(5) : path.join(root, decodeURIComponent(pathname));
            id = query ? `${file}?${query}` : file;
            if (resolves) {
                const resolved = await env.pluginContainer.resolveId(url, path.join(root, 'index.html'));
                if (resolved && !resolved.external) id = resolved.id;
            }
        }
        const loaded = loads ? await env.pluginContainer.load(id) : null;
        if (loaded?.code != null) return { id, code: await transform('pre', loaded.code, id) };
        // A kind of file only a plugin compiles (MDX, GLSL): a module when its transforms change it.
        const file = cleanUrl(id);
        if (!other || !fs.existsSync(file)) return null;
        const raw = fs.readFileSync(file, 'utf8');
        const code = await transform('post', await transform('pre', raw, id), id);
        return code === raw ? null : { id, code, transformed: true };
    };

    const transform = async (phase: 'pre' | 'post', code: string, id: string): Promise<string> => {
        const container = transforms[phase];
        return container ? (await container.transform(code, id)).code : code;
    };

    const middlewares: Connect = createConnect();
    const server: any = {
        config: app.config,
        middlewares,
        httpServer: host.httpServer,
        watcher,
        ws: hot,
        hot,
        environments: { client: env },
        moduleGraph: env.moduleGraph,
        pluginContainer: env.pluginContainer,
        resolvedUrls: { local: [`http://localhost:${host.port}/`], network: [] },
        transformIndexHtml: (url: string, html: string) => indexHtml(url, html),
        async transformRequest(url: string) {
            const mod = await load(url);
            return mod && { code: await transform('post', mod.code, mod.id), map: null };
        },
        async reloadModule() {
            host.send({ type: 'full-reload' });
        },
        async restart() {
            host.send({ type: 'full-reload' });
        },
        printUrls() {},
        openBrowser() {},
        async ssrLoadModule() {
            throw new Error('ssrLoadModule is not available in an app: lunx runs framework projects on its plugin host');
        },
        async close() {},
    };

    // configureServer: its middlewares first; the functions it returns add theirs after lunx's own handling.
    const postHooks: Array<() => any> = [];
    for (const plugin of sortByHook(app.plugins, 'configureServer')) {
        const post = await getHookHandler(plugin.configureServer)!.call({ environment: env }, server);
        if (typeof post === 'function') postHooks.push(post);
    }
    const early = middlewares.stack.length;
    for (const post of postHooks) await post();
    const late = createConnect();
    late.stack = middlewares.stack.splice(early);
    await env.pluginContainer.buildStart();

    const run = (stack: Connect, req: any, res: any) =>
        stack.stack.length === 0
            ? Promise.resolve(false)
            : new Promise<boolean>((resolve, reject) => {
                  const answered = () => resolve(true);
                  res.once('finish', answered);
                  res.once('close', answered);
                  stack.handle(req, res, (err?: any) => {
                      res.off('finish', answered);
                      res.off('close', answered);
                      if (err) reject(err);
                      else resolve(false);
                  });
              });

    return {
        app,
        handle: (req, res) => run(middlewares, req, res),
        handleLate: (req, res) => run(late, req, res),
        async resolveImport(specifier, importer) {
            const resolved = resolves ? await env.pluginContainer.resolveId(specifier, importer) : null;
            if (resolved?.external) return null;
            // A plugin's code may import a file by its path (vite-plugin-wasm's `/abs/x.wasm?url`).
            const id = resolved?.id ?? (path.isAbsolute(cleanUrl(specifier)) && cleanUrl(specifier).startsWith(root + path.sep) && fs.existsSync(cleanUrl(specifier)) ? specifier : null);
            if (!id) return null;
            const file = cleanUrl(id);
            if (!path.isAbsolute(file) || !fs.existsSync(file)) return idToUrl(id);
            // Packages stay with lunx's dependency pre-bundling.
            if (file.split(path.sep).includes('node_modules')) return null;
            const rel = path.relative(root, file);
            const url = rel.startsWith('..') || path.isAbsolute(rel) ? `/@fs/${file.split(path.sep).join('/').replace(/^\//, '')}` : `/${rel.split(path.sep).join('/')}`;
            return url + id.slice(file.length);
        },
        load,
        transform,
        indexHtml,
        fileChanged(file) {
            watcher.emit('change', file);
            watcher.emit('all', 'change', file);
            void env.pluginContainer.watchChange(file, { event: 'update' });
            return [...(dependents.get(path.resolve(file)) ?? [])].filter((dep) => dep !== path.resolve(file) && path.isAbsolute(dep) && fs.existsSync(dep));
        },
        setHttpServer(httpServer) {
            server.httpServer = httpServer;
        },
        close: () => env.pluginContainer.close(),
    };
}
