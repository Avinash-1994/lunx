/**
 * Lunx HMR runtime — the single browser-side client, served as /@lunx/hmr-client.
 *
 * Implements the Vite-compatible `import.meta.hot` API. The dev server prepends
 *   import.meta.hot = createHotContext('/src/App.tsx')
 * to every module that references `import.meta.hot`, keyed by the same
 * root-relative URL the server puts in `update` messages.
 *
 * An update for a module that nothing accepts reloads the page: silently
 * re-importing it would run its side effects again and leave stale bindings
 * in its importers, so the edit would never reach the screen.
 */

type ModuleNamespace = Record<string, unknown>;
type AcceptCallback = (mod: ModuleNamespace | undefined) => void;

interface HotModule {
    id: string;
    selfAccept: AcceptCallback[];
    disposers: Array<(data: Record<string, unknown>) => void>;
    data: Record<string, unknown>;
}

interface ServerError {
    message: string;
    file?: string;
    line?: number;
    column?: number;
    stack?: string;
}

type HmrMessage =
    | { type: 'connected' }
    | { type: 'update'; modules: string[] }
    | { type: 'css-update'; href: string }
    | { type: 'full-reload' }
    | { type: 'reload' }
    | { type: 'error'; error?: ServerError; message?: string; stack?: string }
    | { type: 'error-fixed' };

const hotModules = new Map<string, HotModule>();
const listeners = new Map<string, Array<(payload: unknown) => void>>();

function emit(event: string, payload?: unknown): void {
    for (const cb of listeners.get(event) ?? []) cb(payload);
}

function stamp(key: string): void {
    const w = window as any;
    w.__lunxHmr = w.__lunxHmr ?? {};
    w.__lunxHmr[key] = Date.now();
}

// ─── Error overlay ────────────────────────────────────────────────────────────

let overlay: any = null;

async function showError(err: ServerError): Promise<void> {
    console.error(`[lunx] ${err.file ? err.file + ': ' : ''}${err.message}`);
    try {
        const overlayUrl = '/@lunx/error-overlay.js';
        await import(/* @vite-ignore */ overlayUrl);
        if (!overlay) {
            overlay = document.createElement('lunx-error-overlay');
            document.body.appendChild(overlay);
        }
        overlay.errors = [{ type: 'build', ...err }];
    } catch {
        /* the console message above is the fallback */
    }
}

function clearError(): void {
    overlay?.dismiss?.();
    overlay?.remove?.();
    overlay = null;
}

// ─── Updates ──────────────────────────────────────────────────────────────────

function fullReload(): void {
    emit('vite:beforeFullReload');
    location.reload();
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Batch React Refresh across every module in one update. */
function scheduleReactRefresh(): void {
    const runtime = (window as any).__lunx_react_refresh__;
    if (!runtime) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        runtime.performReactRefresh();
    }, 16);
}

async function handleUpdate(modules: string[]): Promise<void> {
    emit('vite:beforeUpdate', { updates: modules });
    for (const id of modules) {
        const hot = hotModules.get(id);
        if (!hot || hot.selfAccept.length === 0) {
            fullReload();
            return;
        }
        const callbacks = hot.selfAccept.slice();
        for (const dispose of hot.disposers) dispose(hot.data);
        let mod: ModuleNamespace;
        try {
            mod = await import(/* @vite-ignore */ `${id}${id.includes('?') ? '&' : '?'}t=${Date.now()}`);
        } catch (err) {
            console.error(`[lunx] hot update of ${id} failed, reloading`, err);
            fullReload();
            return;
        }
        for (const cb of callbacks) cb(mod);
    }
    scheduleReactRefresh();
    clearError();
    emit('vite:afterUpdate', { updates: modules });
    stamp('lastUpdate');
}

function handleCssUpdate(href: string): void {
    const base = href.split('?')[0];
    const fresh = `${base}?t=${Date.now()}`;
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
        .filter((link) => (link.getAttribute('href') || '').split('?')[0] === base);
    if (links.length > 0) {
        for (const link of links) {
            const next = link.cloneNode() as HTMLLinkElement;
            next.href = fresh;
            next.addEventListener('load', () => link.remove());
            link.after(next);
        }
    } else {
        // CSS imported from JS is a module that injects a <style>; re-running
        // it replaces the sheet. If that fails, a reload is still correct.
        import(/* @vite-ignore */ `${base}?import&t=${Date.now()}`).catch(fullReload);
    }
    stamp('lastCssUpdate');
}

function onMessage(raw: string): void {
    let msg: HmrMessage;
    try {
        msg = JSON.parse(raw);
    } catch {
        return;
    }
    switch (msg.type) {
        case 'connected':
            stamp('connected');
            console.debug('[lunx:hmr] connected');
            break;
        case 'update':
            void handleUpdate(msg.modules);
            break;
        case 'css-update':
            handleCssUpdate(msg.href);
            break;
        case 'full-reload':
        case 'reload':
            fullReload();
            break;
        case 'error':
            void showError(msg.error ?? { message: msg.message ?? 'Build error', stack: msg.stack });
            break;
        case 'error-fixed':
            clearError();
            break;
    }
}

// ─── Connection ───────────────────────────────────────────────────────────────

declare const __LUNX_HMR_URL__: string | undefined;

function hmrUrl(): string {
    if (typeof __LUNX_HMR_URL__ !== 'undefined') return __LUNX_HMR_URL__;
    // The server that served this client: a federated remote's modules run in
    // another app's page but get their updates from their own dev server.
    const own = new URL(import.meta.url);
    const proto = own.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${own.host}/__lunx_hmr`;
}

let everConnected = false;
let retryDelay = 500;

function connect(): void {
    const ws = new WebSocket(hmrUrl());
    ws.addEventListener('open', () => {
        // The server restarted while we were away: modules may have changed
        // under us and its module graph is gone, so start clean.
        if (everConnected) return location.reload();
        everConnected = true;
        retryDelay = 500;
    });
    ws.addEventListener('message', (ev) => onMessage(String(ev.data)));
    ws.addEventListener('close', () => {
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
    });
}

// ─── import.meta.hot ──────────────────────────────────────────────────────────

export function createHotContext(id: string) {
    // Each evaluation of a module starts with a fresh set of handlers; data
    // survives so state can be carried across updates.
    const previous = hotModules.get(id);
    const hot: HotModule = { id, selfAccept: [], disposers: [], data: previous?.data ?? {} };
    hotModules.set(id, hot);

    return {
        get data() {
            return hot.data;
        },
        accept(deps?: string | string[] | AcceptCallback, cb?: AcceptCallback) {
            if (deps === undefined || typeof deps === 'function') {
                hot.selfAccept.push(typeof deps === 'function' ? deps : () => {});
            } else {
                // Accepting a dependency is not tracked yet; treat the edit
                // as a page reload rather than pretend it was applied.
                void cb;
            }
        },
        dispose(cb: (data: Record<string, unknown>) => void) {
            hot.disposers.push(cb);
        },
        prune(cb: (data: Record<string, unknown>) => void) {
            hot.disposers.push(cb);
        },
        decline() {
            hot.selfAccept = [];
        },
        invalidate() {
            fullReload();
        },
        on(event: string, cb: (payload: unknown) => void) {
            listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        },
        off(event: string, cb: (payload: unknown) => void) {
            listeners.set(event, (listeners.get(event) ?? []).filter((x) => x !== cb));
        },
        send() {
            /* custom events to the server are not supported */
        },
    };
}

const w = window as any;
const connected: Set<string> = (w.__lunx_hmr_servers__ ??= new Set());
if (!connected.has(hmrUrl())) {
    connected.add(hmrUrl());
    w.__lunx_hmr_connected__ = true;
    connect();
    w.__lunxHmr = w.__lunxHmr ?? {};
    w.__lunxHmr.simulate = (msg: unknown) => onMessage(JSON.stringify(msg));
}
