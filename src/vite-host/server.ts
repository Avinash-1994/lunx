/**
 * `createServer()`: a Vite-compatible dev server. Plugins get the same
 * `ViteDevServer` object Vite gives them (middlewares, ws/hot, watcher,
 * environments, moduleGraph, ssrLoadModule, transformIndexHtml…), and the
 * internal middlewares carry Vite's names so plugins that look for them
 * (SvelteKit removes the static ones) find them.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { watch } from '../lib/watcher.js';
import { WebSocketServer } from '../lib/ws.js';
import { getHookHandler, resolveConfig, sortByHook, type InlineConfig, type ResolvedConfig } from './config.js';
import { createConnect, type Connect } from './connect.js';
import { DevEnvironment, LoadError, noopHotChannel, type HotChannel } from './environment.js';
import { handleHMRUpdate, updateModules } from './hmr.js';
import { ModuleGraph } from './module-graph.js';
import { idToUrl } from './plugins/import-analysis.js';
import {
    CLIENT_PUBLIC_PATH,
    cleanUrl,
    ENV_PUBLIC_PATH,
    FS_PREFIX,
    fsPathFromId,
    injectQuery,
    isCSSRequest,
    isJSRequest,
    normalizePath,
    removeImportQuery,
    removeTimestampQuery,
    stripBase,
    unwrapId,
} from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.txt': 'text/plain', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.map': 'application/json',
    '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.pdf': 'application/pdf',
};

function send(req: http.IncomingMessage, res: http.ServerResponse, content: string | Buffer, type: string, options: { etag?: string; cacheControl?: string; headers?: Record<string, any> } = {}): void {
    if (res.writableEnded) return;
    if (options.etag && req.headers['if-none-match'] === options.etag) {
        res.statusCode = 304;
        res.end();
        return;
    }
    res.setHeader('Content-Type', type.includes('/') ? type : MIME[`.${type}`] ?? type);
    res.setHeader('Cache-Control', options.cacheControl ?? 'no-cache');
    if (options.etag) res.setHeader('Etag', options.etag);
    for (const [k, v] of Object.entries(options.headers ?? {})) res.setHeader(k, v);
    res.statusCode = 200;
    res.end(content);
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, headers: Record<string, any> = {}): void {
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    send(req, res, fs.readFileSync(file), type, { headers });
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** The hot channel the browser talks to: Vite's protocol over lunx's WebSocket server. */
function createWsHotChannel(config: ResolvedConfig): HotChannel & { attach(server: http.Server | null): void; clients: Set<any> } {
    const wss = new WebSocketServer({ noServer: true });
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    const clients = new Set<any>();
    const wrapClient = (socket: any) => ({
        socket,
        send(...args: any[]) {
            const payload = typeof args[0] === 'string' ? { type: 'custom', event: args[0], data: args[1] } : args[0];
            socket.send(JSON.stringify(payload));
        },
    });
    wss.on('connection', (socket) => {
        const client = wrapClient(socket);
        clients.add(client);
        socket.send(JSON.stringify({ type: 'connected' }));
        socket.on('message', (raw: Buffer | string) => {
            let parsed: any;
            try {
                parsed = JSON.parse(String(raw));
            } catch {
                return;
            }
            if (parsed?.type !== 'custom' || !parsed.event) return;
            for (const fn of listeners.get(parsed.event) ?? []) fn(parsed.data, client);
        });
        socket.on('close', () => clients.delete(client));
        for (const fn of listeners.get('connection') ?? []) fn(client);
    });
    return {
        clients,
        attach(server: http.Server | null) {
            server?.on('upgrade', (req: http.IncomingMessage, socket: any, head: Buffer) => {
                const protocol = req.headers['sec-websocket-protocol'];
                if (protocol !== 'vite-hmr' && protocol !== 'vite-ping') return;
                wss.handleUpgrade(req, socket as any, head, (ws) => wss.emit('connection', ws, req));
            });
        },
        send(...args: any[]) {
            const payload = typeof args[0] === 'string' ? { type: 'custom', event: args[0], data: args[1] } : args[0];
            if (payload.type === 'error' && !config.server.hmr) return;
            const text = JSON.stringify(payload);
            for (const client of clients) client.socket.send(text);
        },
        on(event: string, fn: (...args: any[]) => void) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(fn);
        },
        off(event: string, fn: (...args: any[]) => void) {
            listeners.get(event)?.delete(fn);
        },
        listen() {},
        close() {
            for (const client of clients) client.socket.close();
            wss.close();
        },
    } as any;
}

function noopWatcher(): any {
    const { EventEmitter } = require('node:events') as typeof import('node:events');
    const w: any = new EventEmitter();
    w.add = async () => {};
    w.unwatch = () => {};
    w.close = async () => {};
    w.getWatched = () => ({});
    return w;
}

function clientRuntime(config: ResolvedConfig): string {
    const file = path.join(__dirname, 'client', 'client.js');
    const code = fs.readFileSync(file, 'utf-8');
    const defines = Object.entries({ ...config.define, ...config.environments.client?.define })
        .filter(([k]) => !k.startsWith('import.meta'))
        .map(([k, v]) => `${JSON.stringify(k)}: (${typeof v === 'string' ? v : JSON.stringify(v)})`)
        .join(',\n');
    return code
        .replace(/__LUNX_CLIENT_CONFIG__/g, JSON.stringify({ base: config.base, hmr: config.server.hmr !== false, overlay: (config.server.hmr as any)?.overlay !== false, timeout: 30000 }))
        .replace(/__LUNX_DEFINES__/g, `{${defines}}`)
        .replace(/^export \{\};?$/m, '');
}

async function findPort(port: number, host: string | undefined, strict: boolean): Promise<number> {
    for (let candidate = port; ; candidate++) {
        const free = await new Promise<boolean>((resolve) => {
            const srv = net.createServer();
            srv.once('error', () => resolve(false));
            srv.listen(candidate, host, () => srv.close(() => resolve(true)));
        });
        if (free) return candidate;
        if (strict) throw new Error(`Port ${port} is already in use`);
    }
}

export async function createServer(inlineConfig: InlineConfig = {}): Promise<any> {
    const config = await resolveConfig(inlineConfig, 'serve');
    const middlewares: Connect = createConnect();
    const httpServer = config.server.middlewareMode ? null : http.createServer(middlewares as any);
    const ws = createWsHotChannel(config);
    ws.attach(httpServer ?? (typeof config.server.hmr === 'object' ? (config.server.hmr as any).server : null));

    // `server.watch: null` (child compilers such as React Router's) turns file watching off, as in Vite.
    const watcher: any = config.inlineConfig?.server?.watch === null || (config as any).server.watch === null ? noopWatcher() : watch(config.root, {
        ignoreInitial: true,
        ignored: [
            '**/node_modules/**',
            '**/.git/**',
            config.cacheDir,
            path.resolve(config.root, config.build.outDir),
            ...[].concat((config.server.watch as any)?.ignored ?? []),
        ],
    });

    watcher.on('error', (err: Error) => config.logger.warn(`file watcher: ${err.message}`));
    const environments: Record<string, DevEnvironment> = {};
    for (const name of Object.keys(config.environments)) {
        environments[name] = new DevEnvironment(name, config, name === 'client' ? ws : noopHotChannel());
        environments[name].watcher = watcher;
    }
    const client = environments.client!;
    const ssr = environments.ssr!;
    const moduleGraph = new ModuleGraph(() => client.moduleGraph, () => ssr.moduleGraph);
    if (config.optimizeDeps?.disabled !== true && config.optimizeDeps?.noDiscovery !== true) {
        const { DepsOptimizer } = await import('./optimizer.js');
        const { createEnvResolver } = await import('./plugins/resolve.js');
        client.depsOptimizer = new DepsOptimizer(config, createEnvResolver(config, 'client'), () => {
            // New bundle hashes: every module that imported the old ones is stale.
            client.moduleGraph.invalidateAll();
            ws.send({ type: 'full-reload' });
        });
    }

    let serverClosed = false;
    const server: any = {
        config,
        middlewares,
        httpServer,
        watcher,
        ws,
        hot: ws,
        environments,
        moduleGraph,
        resolvedUrls: null as null | { local: string[]; network: string[] },
        pluginContainer: {
            resolveId: (id: string, importer?: string, options?: any) => (options?.ssr ? ssr : client).pluginContainer.resolveId(id, importer, options),
            load: (id: string, options?: any) => (options?.ssr ? ssr : client).pluginContainer.load(id),
            transform: (code: string, id: string, options?: any) => (options?.ssr ? ssr : client).pluginContainer.transform(code, id),
            getModuleInfo: () => null,
            buildStart: () => client.pluginContainer.buildStart(),
            close: () => Promise.all([client.close(), ssr.close()]),
        },
        transformRequest(url: string, options?: { ssr?: boolean }) {
            return (options?.ssr ? ssr : client).transformRequest(url);
        },
        warmupRequest(url: string, options?: { ssr?: boolean }) {
            return (options?.ssr ? ssr : client).warmupRequest(url);
        },
        async transformIndexHtml(url: string, html: string, originalUrl?: string) {
            return applyHtmlTransforms(server, url, html, originalUrl);
        },
        async ssrLoadModule(url: string, _opts?: { fixStacktrace?: boolean }) {
            return ssr.ssrLoadModule(url);
        },
        async ssrTransform(code: string, _inMap: any, url: string) {
            const { ssrTransform } = await import('../engines/toolkit.js');
            const name = cleanUrl(url).replace(/^\0/, '');
            const result = await ssrTransform(/\.(m|c)?js$/.test(name) ? name : `${name}.js`, code);
            return { code: result.code, map: result.map ?? null, deps: result.deps, dynamicDeps: result.dynamicDeps };
        },
        ssrFixStacktrace(_e: Error) {},
        ssrRewriteStacktrace(stack: string) {
            return stack;
        },
        async reloadModule(module: any) {
            const mod = module._clientModule ?? module;
            if (mod && client.moduleGraph.idToModuleMap.has(mod.id)) updateModules(client, mod.file ?? mod.url, [mod], Date.now());
        },
        async listen(port?: number, isRestart?: boolean) {
            if (!httpServer) return server;
            const host = config.server.host === true ? '0.0.0.0' : (config.server.host as string | undefined);
            const listenPort = await findPort(port ?? config.server.port, host, !!config.server.strictPort);
            await new Promise<void>((resolve, reject) => {
                httpServer.once('error', reject);
                httpServer.listen(listenPort, host, () => {
                    httpServer.off('error', reject);
                    resolve();
                });
            });
            const local = `http://${host && host !== '0.0.0.0' ? host : 'localhost'}:${listenPort}${config.base}`;
            server.resolvedUrls = { local: [local], network: host === '0.0.0.0' ? [`http://0.0.0.0:${listenPort}${config.base}`] : [] };
            if (!isRestart && config.server.open) server.openBrowser();
            client.depsOptimizer?.start();
            return server;
        },
        async close() {
            if (serverClosed) return;
            serverClosed = true;
            await Promise.allSettled([
                watcher.close(),
                ws.close(),
                ...Object.values(environments).map((e) => e.close()),
                httpServer ? new Promise<void>((r) => { httpServer.closeAllConnections?.(); httpServer.close(() => r()); }) : undefined,
            ]);
        },
        printUrls() {
            for (const url of server.resolvedUrls?.local ?? []) config.logger.info(`  ➜  Local:   ${url}`);
            for (const url of server.resolvedUrls?.network ?? []) config.logger.info(`  ➜  Network: ${url}`);
        },
        bindCLIShortcuts() {},
        openBrowser() {},
        async waitForRequestsIdle() {},
        async restart() {
            const port = (httpServer?.address() as net.AddressInfo | null)?.port;
            await server.close();
            const next = await createServer(inlineConfig);
            Object.assign(server, next, { restart: next.restart });
            await next.listen(port, true);
        },
        [Symbol.asyncDispose]() {
            return server.close();
        },
    };

    // Client → server events.
    ws.on('vite:invalidate', ({ path: url }: { path: string }) => {
        const mod = client.moduleGraph.urlToModuleMap.get(url);
        if (mod && mod.isSelfAccepting && mod.lastHMRTimestamp > 0 && !mod.lastHMRInvalidationReceived) {
            mod.lastHMRInvalidationReceived = true;
            updateModules(client, mod.file ?? url, [...mod.importers], mod.lastHMRTimestamp, true);
        }
    });

    // File changes → module graph invalidation → plugins → HMR.
    const onFile = (type: 'create' | 'update' | 'delete') => async (file: string) => {
        file = normalizePath(file);
        for (const env of Object.values(environments)) {
            if (type === 'update') env.moduleGraph.onFileChange(file);
            if (type === 'delete') env.moduleGraph.onFileDelete(file);
            await env.pluginContainer.watchChange(file, { event: type });
        }
        try {
            await handleHMRUpdate(type, file, server);
        } catch (err: any) {
            ws.send({ type: 'error', err: { message: err.message, stack: err.stack ?? '' } });
        }
    };
    watcher.on('change', onFile('update'));
    watcher.on('add', onFile('create'));
    watcher.on('unlink', onFile('delete'));

    // configureServer: pre hooks now, returned post hooks after the internal middlewares.
    const postHooks: Array<() => any> = [];
    for (const plugin of sortByHook(config.plugins, 'configureServer')) {
        const post = await getHookHandler(plugin.configureServer)!.call({ environment: client }, server);
        if (typeof post === 'function') postHooks.push(post);
    }

    if (config.base !== '/') {
        middlewares.use(function viteBaseMiddleware(req: any, res: any, next: any) {
            const url = req.url as string;
            if (url.startsWith(config.base) || url === config.base.slice(0, -1)) {
                req.url = stripBase(url, config.base);
                return next();
            }
            if (url === '/' || url === '/index.html') {
                res.writeHead(302, { Location: config.base });
                res.end();
                return;
            }
            next();
        });
    }

    middlewares.use(function viteHMRPingMiddleware(req: any, res: any, next: any) {
        if (req.headers.accept === 'text/x-vite-ping') {
            res.writeHead(204).end();
            return;
        }
        next();
    });

    if (config.publicDir && fs.existsSync(config.publicDir)) {
        middlewares.use(function viteServePublicMiddleware(req: any, res: any, next: any) {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            const pathname = decodeURIComponent(cleanUrl(req.url));
            const file = path.join(config.publicDir, pathname);
            if (!file.startsWith(config.publicDir) || !isFile(file) || /[?&]import\b/.test(req.url)) return next();
            serveFile(req, res, file, config.server.headers);
        });
    }

    middlewares.use(function viteTransformMiddleware(req: any, res: any, next: any) {
        if (req.method !== 'GET') return next();
        let url: string;
        try {
            url = decodeURI(removeTimestampQuery(req.url));
        } catch {
            return next();
        }
        if (url === '/' || url === '/favicon.ico' || url.endsWith('.map')) return next();
        if (url === CLIENT_PUBLIC_PATH || url.startsWith(CLIENT_PUBLIC_PATH + '?')) {
            return send(req, res, clientRuntime(config), 'js', { headers: config.server.headers });
        }
        if (url === ENV_PUBLIC_PATH) return send(req, res, 'export {};', 'js');
        const isImport = /[?&]import\b/.test(url);
        if (!(isJSRequest(url) || isImport || isCSSRequest(url) || url.startsWith('/@id/'))) return next();
        (async () => {
            url = unwrapId(removeImportQuery(url));
            if (isCSSRequest(url) && !isImport && String(req.headers.accept ?? '').includes('text/css')) url = injectQuery(url, 'direct');
            const result = await client.transformRequest(url);
            if (!result) return next();
            const type = isCSSRequest(url) && /[?&]direct\b/.test(url) ? 'css' : 'js';
            send(req, res, result.code, type, { etag: result.etag, cacheControl: 'no-cache', headers: config.server.headers });
        })().catch((err: any) => {
            if (err instanceof LoadError || err?.code === 'ERR_LOAD_URL') return next();
            config.logger.error(`Internal server error: ${err.message}`, { timestamp: true, error: err });
            ws.send({ type: 'error', err: { message: err.message, stack: err.stack ?? '', id: err.id, plugin: err.plugin, loc: err.loc } });
            next(err);
        });
    });

    middlewares.use(function viteServeRawFsMiddleware(req: any, res: any, next: any) {
        if (!req.url?.startsWith(FS_PREFIX)) return next();
        const file = fsPathFromId(decodeURIComponent(cleanUrl(req.url)));
        const allowed = config.server.fs.strict === false || config.server.fs.allow.some((dir: string) => file.startsWith(dir));
        if (!allowed) {
            res.statusCode = 403;
            res.end(`The request url "${file}" is outside of Vite serving allow list.`);
            return;
        }
        if (!isFile(file)) return next();
        serveFile(req, res, file, config.server.headers);
    });

    middlewares.use(function viteServeStaticMiddleware(req: any, res: any, next: any) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const pathname = decodeURIComponent(cleanUrl(req.url));
        if (pathname.endsWith('/') || pathname.endsWith('.html')) return next();
        const file = path.join(config.root, pathname);
        if (!file.startsWith(config.root) || !isFile(file)) return next();
        serveFile(req, res, file, config.server.headers);
    });

    const spa = config.appType === 'spa' || config.appType === 'mpa';
    if (spa) {
        middlewares.use(function viteHtmlFallbackMiddleware(req: any, _res: any, next: any) {
            // As Vite: a missing Accept, text/html or */* all count as a page request.
            const accept = req.headers.accept;
            if ((req.method !== 'GET' && req.method !== 'HEAD') || !(accept === undefined || accept === '' || accept.includes('text/html') || accept.includes('*/*'))) return next();
            const pathname = decodeURIComponent(cleanUrl(req.url));
            if (pathname.endsWith('.html') && isFile(path.join(config.root, pathname))) return next();
            const asDir = path.join(config.root, pathname, 'index.html');
            if (isFile(asDir)) req.url = path.posix.join(pathname, 'index.html');
            else if (config.appType === 'spa') req.url = '/index.html';
            next();
        });
    }

    for (const post of postHooks) await post();

    if (spa) {
        middlewares.use(async function viteIndexHtmlMiddleware(req: any, res: any, next: any) {
            if (res.writableEnded) return next();
            const pathname = decodeURIComponent(cleanUrl(req.url));
            if (!pathname.endsWith('.html')) return next();
            const file = path.join(config.root, pathname);
            if (!isFile(file)) return next();
            try {
                const html = await server.transformIndexHtml(pathname, await fsp.readFile(file, 'utf-8'), req.originalUrl);
                send(req, res, html, 'html', { headers: config.server.headers });
            } catch (err) {
                next(err);
            }
        });
        middlewares.use(function vite404Middleware(_req: any, res: any) {
            res.statusCode = 404;
            res.end();
        });
    }

    middlewares.use(function viteErrorMiddleware(err: any, req: any, res: any, next: any) {
        if (res.headersSent) return next(err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><html><head><script type="module" src="${config.base}@vite/client"></script></head><body><pre>${String(err?.stack ?? err).replace(/</g, '&lt;')}</pre></body></html>`);
    });

    await Promise.all(Object.values(environments).map((e) => e.init()));
    return server;
}

/** transformIndexHtml hooks (pre, normal, post) plus the /@vite/client tag. */
async function applyHtmlTransforms(server: any, url: string, html: string, originalUrl?: string): Promise<string> {
    const { config } = server;
    const pre: any[] = [];
    const normal: any[] = [];
    const post: any[] = [];
    for (const plugin of config.plugins) {
        const hook = plugin.transformIndexHtml;
        if (!hook) continue;
        const order = typeof hook === 'object' ? hook.order ?? hook.enforce : undefined;
        const handler = typeof hook === 'object' ? hook.handler ?? hook.transform : hook;
        (order === 'pre' ? pre : order === 'post' ? post : normal).push({ plugin, handler });
    }
    const filename = path.join(config.root, cleanUrl(url));
    const ctx = { path: cleanUrl(url), filename, server, originalUrl };
    const tags: any[] = [];
    for (const { plugin, handler } of [...pre, ...normal, ...post]) {
        const result = await handler.call({ environment: server.environments.client }, html, { ...ctx, plugin });
        if (!result) continue;
        if (typeof result === 'string') html = result;
        else if (Array.isArray(result)) tags.push(...result);
        else {
            if (result.html) html = result.html;
            if (result.tags) tags.push(...result.tags);
        }
    }
    tags.unshift({ tag: 'script', attrs: { type: 'module', src: `${config.base}@vite/client` }, injectTo: 'head-prepend' });
    return injectTags(html, tags);
}

function serializeTag({ tag, attrs, children }: any): string {
    const attrText = Object.entries(attrs ?? {})
        .filter(([, v]) => v !== false && v != null)
        .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}=${JSON.stringify(String(v))}`))
        .join('');
    const inner = typeof children === 'string' ? children : Array.isArray(children) ? children.map(serializeTag).join('') : '';
    return /^(meta|link|base|br|hr|img|input)$/.test(tag) ? `<${tag}${attrText}>` : `<${tag}${attrText}>${inner}</${tag}>`;
}

function injectTags(html: string, tags: any[]): string {
    const groups: Record<string, string[]> = { 'head-prepend': [], head: [], 'body-prepend': [], body: [] };
    for (const tag of tags) (groups[tag.injectTo ?? 'head-prepend'] ?? groups.head!).push(serializeTag(tag));
    const at = (re: RegExp, text: string, before: boolean) => {
        if (!text) return;
        const m = html.match(re);
        if (!m || m.index === undefined) {
            html = before ? text + html : html + text;
            return;
        }
        const i = before ? m.index : m.index;
        const pos = before ? i + m[0].length : i;
        html = html.slice(0, pos) + text + html.slice(pos);
    };
    at(/<head[^>]*>/i, groups['head-prepend']!.join(''), true);
    at(/<\/head>/i, groups.head!.join(''), false);
    at(/<body[^>]*>/i, groups['body-prepend']!.join(''), true);
    at(/<\/body>/i, groups.body!.join(''), false);
    return html;
}

export { idToUrl };
