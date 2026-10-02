/// <reference lib="dom" />
/**
 * Browser runtime served at /@vite/client: Vite's HMR protocol and the
 * `import.meta.hot` API (accept, dispose, prune, invalidate, on/off/send,
 * data), style injection for CSS modules and an error overlay.
 * The server replaces the two placeholders below when serving it.
 */

declare const __LUNX_CLIENT_CONFIG__: { base: string; hmr: boolean; overlay: boolean; timeout: number; socket: { port: number | null; host: string | null; path: string | null; protocol: string | null } | null };
declare const __LUNX_DEFINES__: Record<string, unknown>;

const config = __LUNX_CLIENT_CONFIG__;
const base = config.base || '/';

// `define` entries become globals in dev, as in Vite's /@vite/env.
try {
    const defines = __LUNX_DEFINES__;
    for (const key of Object.keys(defines)) {
        const segments = key.split('.');
        let target: any = globalThis;
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i]!;
            if (i === segments.length - 1) target[segment] = defines[key];
            else target = target[segment] ?? (target[segment] = {});
        }
    }
} catch {
    /* frozen globals */
}

type Callback = { deps: string[]; fn: (modules: unknown[]) => void };
interface HotModule {
    id: string;
    callbacks: Callback[];
}

const hotModulesMap = new Map<string, HotModule>();
const disposeMap = new Map<string, (data: any) => void | Promise<void>>();
const pruneMap = new Map<string, (data: any) => void | Promise<void>>();
const dataMap = new Map<string, any>();
const customListenersMap = new Map<string, Array<(data: any) => void>>();
const ctxToListenersMap = new Map<string, Map<string, Array<(data: any) => void>>>();

let socket: WebSocket | null = null;
const outbox: string[] = [];

function send(payload: unknown): void {
    const text = JSON.stringify(payload);
    if (socket && socket.readyState === 1) socket.send(text);
    else outbox.push(text);
}

function notifyListeners(event: string, data: unknown): void {
    for (const cb of customListenersMap.get(event) ?? []) cb(data);
}

function connect(): void {
    if (!config.hmr) return;
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    // The page's own host, or a dedicated HMR port (frameworks running the server in middleware mode).
    const sock = config.socket;
    const host = `${sock?.host || location.hostname}${sock?.port ? `:${sock.port}` : location.port ? `:${location.port}` : ''}`;
    socket = new WebSocket(`${sock?.protocol || protocol}://${host}${sock?.path ?? base}`, 'vite-hmr');
    let opened = false;
    socket.addEventListener('open', () => {
        opened = true;
        notifyListeners('vite:ws:connect', { webSocket: socket });
        for (const text of outbox.splice(0)) socket!.send(text);
    });
    socket.addEventListener('message', ({ data }) => handleMessage(JSON.parse(data)));
    socket.addEventListener('close', async () => {
        notifyListeners('vite:ws:disconnect', { webSocket: socket });
        if (!opened) return;
        console.log('[vite] server connection lost. Polling for restart...');
        await waitForServer();
        location.reload();
    });
}

async function waitForServer(): Promise<void> {
    for (;;) {
        try {
            await fetch(base, { mode: 'no-cors', headers: { Accept: 'text/x-vite-ping' } });
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
}

let pending = false;
let queued: Array<Promise<(() => void) | undefined>> = [];

async function queueUpdate(p: Promise<(() => void) | undefined>): Promise<void> {
    queued.push(p);
    if (pending) return;
    pending = true;
    await Promise.resolve();
    pending = false;
    const loading = [...queued];
    queued = [];
    for (const fn of await Promise.all(loading)) fn?.();
}

async function handleMessage(payload: any): Promise<void> {
    switch (payload.type) {
        case 'connected':
            console.debug('[vite] connected.');
            break;
        case 'update':
            notifyListeners('vite:beforeUpdate', payload);
            if (hasErrorOverlay()) {
                location.reload();
                return;
            }
            clearErrorOverlay();
            await Promise.all(
                payload.updates.map(async (update: any) => {
                    if (update.type === 'js-update') return queueUpdate(fetchUpdate(update));
                    const searchUrl = cleanUrl(update.path);
                    const el = [...document.querySelectorAll<HTMLLinkElement>('link')].find(
                        (e) => !outdatedLinkTags.has(e) && cleanUrl(e.href).endsWith(searchUrl),
                    );
                    if (!el) return;
                    const newPath = `${base}${searchUrl.slice(1)}${searchUrl.includes('?') ? '&' : '?'}t=${update.timestamp}`;
                    return new Promise<void>((resolve) => {
                        const next = el.cloneNode() as HTMLLinkElement;
                        next.href = new URL(newPath, el.href).href;
                        const done = () => {
                            el.remove();
                            resolve();
                        };
                        next.addEventListener('load', done);
                        next.addEventListener('error', done);
                        outdatedLinkTags.add(el);
                        el.after(next);
                    });
                }),
            );
            notifyListeners('vite:afterUpdate', payload);
            break;
        case 'custom':
            notifyListeners(payload.event, payload.data);
            break;
        case 'full-reload':
            notifyListeners('vite:beforeFullReload', payload);
            if (payload.path && payload.path.endsWith('.html')) {
                const pagePath = decodeURI(location.pathname);
                const payloadPath = base + payload.path.slice(1);
                if (pagePath === payloadPath || payload.path === '/index.html' || (pagePath.endsWith('/') && pagePath + 'index.html' === payloadPath)) {
                    location.reload();
                }
                return;
            }
            location.reload();
            break;
        case 'prune':
            notifyListeners('vite:beforePrune', payload);
            for (const path of payload.paths) {
                const fn = pruneMap.get(path);
                if (fn) await fn(dataMap.get(path));
            }
            break;
        case 'error': {
            notifyListeners('vite:error', payload);
            const err = payload.err;
            console.error(`[vite] Internal Server Error\n${err.message}\n${err.stack ?? ''}`);
            if (config.overlay) showErrorOverlay(err);
            break;
        }
        case 'ping':
            break;
    }
}

const outdatedLinkTags = new WeakSet<HTMLLinkElement>();

function cleanUrl(url: string): string {
    const u = new URL(url, location.origin);
    u.searchParams.delete('t');
    u.searchParams.delete('direct');
    return u.pathname + u.search;
}

async function fetchUpdate({ path, acceptedPath, timestamp, explicitImportRequired, isWithinCircularImport }: any): Promise<(() => void) | undefined> {
    const mod = hotModulesMap.get(path);
    if (!mod) return;
    let fetched: unknown;
    const isSelfUpdate = path === acceptedPath;
    const qualified = mod.callbacks.filter(({ deps }) => deps.includes(acceptedPath));
    if (isSelfUpdate || qualified.length > 0) {
        const disposer = disposeMap.get(acceptedPath);
        if (disposer) await disposer(dataMap.get(acceptedPath));
        const [pathname, query] = acceptedPath.split('?');
        try {
            fetched = await import(
                /* @vite-ignore */ base + pathname.slice(1) + `?${explicitImportRequired ? 'import&' : ''}t=${timestamp}${query ? `&${query}` : ''}`
            );
        } catch (e) {
            if (isWithinCircularImport) location.reload();
            console.error(e);
            console.error(`[hmr] Failed to reload ${acceptedPath}. This could be due to syntax errors or importing non-existent modules. (see errors above)`);
        }
    }
    return () => {
        for (const { deps, fn } of qualified) fn(deps.map((dep) => (dep === acceptedPath ? fetched : undefined)));
        console.debug(`[vite] hot updated: ${isSelfUpdate ? path : `${acceptedPath} via ${path}`}`);
    };
}

export function createHotContext(ownerPath: string): any {
    if (!dataMap.has(ownerPath)) dataMap.set(ownerPath, {});
    const mod = hotModulesMap.get(ownerPath);
    if (mod) mod.callbacks = [];
    const stale = ctxToListenersMap.get(ownerPath);
    if (stale) {
        for (const [event, staleFns] of stale) {
            const listeners = customListenersMap.get(event);
            if (listeners) customListenersMap.set(event, listeners.filter((l) => !staleFns.includes(l)));
        }
    }
    const newListeners = new Map<string, Array<(data: any) => void>>();
    ctxToListenersMap.set(ownerPath, newListeners);

    const acceptDeps = (deps: string[], fn: (modules: unknown[]) => void = () => {}) => {
        const entry = hotModulesMap.get(ownerPath) ?? { id: ownerPath, callbacks: [] };
        entry.callbacks.push({ deps, fn });
        hotModulesMap.set(ownerPath, entry);
    };

    return {
        get data() {
            return dataMap.get(ownerPath);
        },
        accept(deps?: any, callback?: any) {
            if (typeof deps === 'function' || !deps) acceptDeps([ownerPath], ([m]) => deps?.(m));
            else if (typeof deps === 'string') acceptDeps([deps], ([m]) => callback?.(m));
            else if (Array.isArray(deps)) acceptDeps(deps, callback);
            else throw new Error('invalid hot.accept() usage.');
        },
        acceptExports(_: unknown, callback?: (m: unknown) => void) {
            acceptDeps([ownerPath], ([m]) => callback?.(m));
        },
        dispose(cb: (data: any) => void) {
            disposeMap.set(ownerPath, cb);
        },
        prune(cb: (data: any) => void) {
            pruneMap.set(ownerPath, cb);
        },
        decline() {},
        invalidate(message?: string) {
            notifyListeners('vite:invalidate', { path: ownerPath, message });
            send({ type: 'custom', event: 'vite:invalidate', data: { path: ownerPath, message } });
            console.debug(`[vite] invalidate ${ownerPath}${message ? `: ${message}` : ''}`);
        },
        on(event: string, cb: (data: any) => void) {
            const add = (map: Map<string, Array<(data: any) => void>>) => {
                const list = map.get(event) ?? [];
                list.push(cb);
                map.set(event, list);
            };
            add(customListenersMap);
            add(newListeners);
        },
        off(event: string, cb: (data: any) => void) {
            const remove = (map: Map<string, Array<(data: any) => void>>) => {
                const list = map.get(event);
                if (!list) return;
                const next = list.filter((l) => l !== cb);
                if (next.length) map.set(event, next);
                else map.delete(event);
            };
            remove(customListenersMap);
            remove(newListeners);
        },
        send(event: string, data?: unknown) {
            send({ type: 'custom', event, data });
        },
    };
}

const sheets = new Map<string, HTMLStyleElement>();

export function updateStyle(id: string, content: string): void {
    let style = sheets.get(id);
    if (!style) {
        style = document.createElement('style');
        style.setAttribute('type', 'text/css');
        style.setAttribute('data-vite-dev-id', id);
        style.textContent = content;
        document.head.appendChild(style);
        sheets.set(id, style);
    } else {
        style.textContent = content;
    }
}

export function removeStyle(id: string): void {
    const style = sheets.get(id);
    if (style) {
        document.head.removeChild(style);
        sheets.delete(id);
    }
}

export function injectQuery(url: string, queryToInject: string): string {
    if (url[0] !== '.' && url[0] !== '/') return url;
    const pathname = url.replace(/[?#].*$/, '');
    const { search, hash } = new URL(url, 'http://vite.dev');
    return `${pathname}?${queryToInject}${search ? '&' + search.slice(1) : ''}${hash || ''}`;
}

const OVERLAY_ID = 'vite-error-overlay';

function showErrorOverlay(err: { message: string; stack?: string; id?: string; plugin?: string }): void {
    clearErrorOverlay();
    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.setAttribute('style', 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.66);display:flex;align-items:flex-start;justify-content:center;overflow:auto;font:14px/1.5 ui-monospace,monospace');
    const box = document.createElement('pre');
    box.setAttribute('style', 'margin:60px 16px;max-width:960px;width:100%;padding:24px;background:#181818;color:#fff;border-top:6px solid #ff5555;border-radius:6px;white-space:pre-wrap;word-break:break-word');
    box.textContent = `${err.plugin ? `[plugin:${err.plugin}] ` : ''}${err.message}${err.id ? `\n${err.id}` : ''}\n\n${err.stack ?? ''}\n\nClick outside or fix the code to dismiss.`;
    el.appendChild(box);
    el.addEventListener('click', (e) => e.target === el && clearErrorOverlay());
    document.body.appendChild(el);
}

function clearErrorOverlay(): void {
    document.getElementById(OVERLAY_ID)?.remove();
}

function hasErrorOverlay(): boolean {
    return !!document.getElementById(OVERLAY_ID);
}

export class ErrorOverlay {
    constructor(err: any) {
        showErrorOverlay(err);
    }
}

connect();
