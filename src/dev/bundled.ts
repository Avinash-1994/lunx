/**
 * Bundled dev (`server.bundle: true` or `lunx dev --bundle`): the app is
 * served as a few bundles built by Rolldown's dev engine, as Rspack and
 * Vite's full-bundle mode do, instead of one request per module. A page of
 * thousands of modules loads in one request, so the first visit stays fast
 * however large the app grows. Hot updates are patches of the changed modules,
 * applied by the runtime below (accept / dispose / invalidate, React Refresh).
 *
 * The sources go through lunx's dev compilers (frameworks, React Refresh,
 * CSS); Rolldown resolves, bundles node_modules and builds the patches.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CSS_LANGS, compileCss, isCssModule, resolveCssFile } from '../build/css.js';
import { requireEsm } from '../engines/require-esm.js';
import type { AliasEntry } from '../config/aliases.js';

export interface BundledDevOptions {
    root: string;
    /** Page whose `<script type="module" src>` entries are bundled. */
    html: string;
    defines: Record<string, string>;
    aliases: AliasEntry[];
    sourcemap: boolean;
    /**
     * JSX that Rolldown compiles itself (React, Preact, vanilla): sources skip lunx's
     * compilers, which then run only on .vue / .svelte files. `null`: every source goes
     * through `compile` (Solid, Angular, … and the React Compiler).
     */
    jsx: { importSource?: string; refresh: boolean } | null;
    /** lunx's dev compile of one source file (framework compilers, React Refresh). */
    compile(file: string, code: string): Promise<{ code: string; map?: string | null }>;
    log: { info(msg: string): void; error(msg: string): void };
}

export interface BundledDev {
    /** Settles after the first build (errors included: the page shows them). */
    ready: Promise<void>;
    /** The page with its module entries pointing at their bundles. */
    rewriteHtml(html: string): string;
    /** A bundle, chunk, patch or source map under `/@lunx/bundle/`. */
    serve(url: string): Promise<{ body: string; type: string } | null>;
    /** A browser's HMR socket. */
    attach(ws: { send(data: string): void; on(event: string, cb: (data: any) => void): void }): void;
    /** Whether a file is in the bundles (its changes arrive as patches). */
    owns(file: string): boolean;
    close(): Promise<void>;
}

export const BUNDLE_PREFIX = '/@lunx/bundle/';
const ASSET = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|flac|aac|pdf|txt|wasm)$/i;

/** `<script type="module" src="…">` entries of a page that are files of this project. */
export function moduleEntries(root: string, html: string, htmlFile: string): Map<string, string> {
    const entries = new Map<string, string>();
    for (const m of html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi)) {
        const src = m[1]!;
        if (/^(https?:)?\/\/|^\/@/.test(src)) continue;
        const file = src.startsWith('/') ? path.join(root, src.split('?')[0]!) : path.resolve(path.dirname(htmlFile), src.split('?')[0]!);
        if (fs.existsSync(file)) entries.set(src, file);
    }
    return entries;
}

export async function startBundledDev(options: BundledDevOptions): Promise<BundledDev | null> {
    const { root } = options;
    const entries = moduleEntries(root, fs.readFileSync(options.html, 'utf8'), options.html);
    if (!entries.size) return null;
    const names = new Map<string, string>(); // src → bundle name
    const input: Record<string, string> = {};
    for (const [src, file] of entries) {
        let name = path.basename(file).replace(/\.[^.]+$/, '') || 'index';
        for (let i = 2; name in input; i++) name = `${path.basename(file).replace(/\.[^.]+$/, '')}-${i}`;
        input[name] = file;
        names.set(src, name);
    }

    const { dev, viteImportGlobPlugin } = await requireEsm('rolldown/experimental');
    const files = new Map<string, string>(); // published path → content
    const clients = new Map<string, { send(data: string): void }>();
    const patches = new Map<string, string>(); // `${clientId}/${filename}` → code
    let buildError: string | null = null;
    let settle!: () => void;
    const ready = new Promise<void>((r) => (settle = r));
    const realRoot = fs.realpathSync(root);
    const graph = new Set<string>();

    const toUrl = (file: string): string => {
        const rel = path.relative(root, file).split(path.sep).join('/');
        return rel.startsWith('..') ? '/@fs/' + file.split(path.sep).join('/').replace(/^\//, '') : '/' + rel;
    };
    const inProject = (id: string) => (id.startsWith(root + path.sep) || id.startsWith(realRoot + path.sep)) && !id.includes(`${path.sep}node_modules${path.sep}`);
    const sendAll = (msg: object) => {
        const data = JSON.stringify(msg);
        for (const c of clients.values()) c.send(data);
    };

    const lunxPlugin = {
        name: 'lunx:bundled-dev',
        load: {
          // Only what Rolldown cannot load itself: a JS hook call per module costs ~0.5 ms.
          filter: { id: new RegExp(`${CSS_LANGS.source.replace(/\$$/, '')}(\\?|$)|${ASSET.source.replace(/\$$/, '')}(\\?|$)|\\?`, 'i') },
          async handler(id: string) {
            const [file, query = ''] = id.split('?') as [string, string?];
            if (CSS_LANGS.test(file)) {
                if (!fs.existsSync(file)) return null;
                const compiled = await compileCss({
                    root,
                    file,
                    source: fs.readFileSync(file, 'utf8'),
                    modules: isCssModule(file),
                    minify: false,
                    resolveUrl: (from: string, ref: string) => {
                        if (/^(data:|https?:|\/\/|#|\/)/.test(ref)) return ref;
                        const target = resolveCssFile(root, from, ref);
                        return target ? toUrl(target) : ref;
                    },
                });
                if (/(^|&)inline\b/.test(query)) return { code: `export default ${JSON.stringify(compiled.code)};`, moduleType: 'js' };
                const key = JSON.stringify(toUrl(file));
                // One <style> per file, replaced in place when the module re-runs on an update.
                return {
                    code: `let el = document.querySelector('style[data-lunx-css=' + JSON.stringify(${key}) + ']');
if (!el) { el = document.createElement('style'); el.setAttribute('data-lunx-css', ${key}); document.head.appendChild(el); }
el.textContent = ${JSON.stringify(compiled.code)};
export default ${JSON.stringify(compiled.exports ?? compiled.code)};
import.meta.hot?.accept();
`,
                    moduleType: 'js',
                    moduleSideEffects: true,
                };
            }
            if (/(^|&)raw\b/.test(query) && fs.existsSync(file)) return { code: `export default ${JSON.stringify(fs.readFileSync(file, 'utf8'))};`, moduleType: 'js' };
            if ((/(^|&)url\b/.test(query) || ASSET.test(file)) && fs.existsSync(file) && !/\.(json|[mc]?[jt]sx?)$/.test(file)) {
                return { code: `export default ${JSON.stringify(toUrl(file))};`, moduleType: 'js' };
            }
            const worker = /(^|&)(shared)?worker\b/.exec(query);
            if (worker) {
                // The worker loads as unbundled modules, which the dev server still serves.
                const url = `new URL(${JSON.stringify(toUrl(file))}, location.origin)`;
                return {
                    code: /(^|&)url\b/.test(query)
                        ? `export default ${url}.href;`
                        : `export default function WorkerWrapper(options) { return new ${worker[2] ? 'SharedWorker' : 'Worker'}(${url}, { type: 'module', name: options?.name }); }`,
                    moduleType: 'js',
                };
            }
            return null;
          },
        },
        transform: {
            filter: { id: options.jsx ? /\.(vue|svelte)$/ : /\.(m?[jt]sx?|vue|svelte)$/ },
            async handler(this: any, code: string, id: string) {
                if (id.includes('?') || !inProject(id)) return null;
                graph.add(id);
                // Files a component pulls in (Angular templateUrl / styleUrls, SFC src="…"): a save to one re-compiles it.
                for (const m of code.matchAll(/\b(?:templateUrl|styleUrl)\s*:\s*['"`]([^'"`]+)['"`]|\bstyleUrls\s*:\s*\[([^\]]*)\]|<(?:template|script|style)\b[^>]*\bsrc=["']([^"']+)["']/g)) {
                    const refs = m[2] ? [...m[2].matchAll(/['"`]([^'"`]+)['"`]/g)].map((r) => r[1]!) : [(m[1] ?? m[3])!];
                    for (const ref of refs) {
                        const dep = path.resolve(path.dirname(id), ref);
                        this.addWatchFile(dep);
                        graph.add(dep);
                    }
                }
                const out = await options.compile(id, code);
                // The compilers inline their source map: Rolldown takes it as the module's map.
                let map = out.map ?? null;
                const compiled = out.code.replace(/\n?\/\/# sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)[^\S\n]*(?=\n|$)/, (_m, b64: string) => {
                    map ??= Buffer.from(b64, 'base64').toString('utf8');
                    return '';
                });
                return { code: compiled, map, moduleType: 'js' };
            },
        },
    };

    // After hot updates the bundles are behind the sources: rebuilt once the edits pause, so a reload is quick.
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
    const rebuildLater = () => {
        if (rebuildTimer) clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
            rebuildTimer = null;
            void engine.ensureLatestBuildOutput().catch(() => {});
        }, 1500);
        rebuildTimer.unref?.();
    };
    const alias: Record<string, string> = {};
    for (const a of options.aliases) alias[a.find] = a.replacement;
    const engine = await dev(
        {
            input,
            cwd: root,
            platform: 'browser',
            resolve: { alias, extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte', '.json'], conditionNames: ['development', 'browser', 'import', 'module', 'default'] },
            transform: {
                define: options.defines,
                ...(options.jsx ? { jsx: { runtime: 'automatic', importSource: options.jsx.importSource, development: true, refresh: options.jsx.refresh } } : {}),
            },
            plugins: [lunxPlugin, viteImportGlobPlugin({ root })],
            moduleTypes: { '.vue': 'js', '.svelte': 'js' },
            experimental: { devMode: { implement: CLIENT_RUNTIME } },
            onLog(level: string, logItem: any) {
                if (level === 'warn' && !/EVAL|CIRCULAR|MIXED_EXPORTS|EMPTY_IMPORT_META/.test(logItem.code ?? '')) options.log.info(`[bundle] ${logItem.message}`);
            },
        },
        {
            dir: path.join(root, 'node_modules', '.lunx', 'bundle'),
            format: 'esm',
            sourcemap: options.sourcemap,
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash][extname]',
        },
        {
            watch: { skipWrite: true },
            onOutput(result: any) {
                if (result instanceof Error) {
                    buildError = result.message;
                    options.log.error(result.message);
                    sendAll({ type: 'lunx:bundle-error', message: result.message });
                } else {
                    buildError = null;
                    files.clear();
                    for (const o of result.output) files.set(o.fileName, o.type === 'chunk' ? o.code : String(o.source));
                }
                settle();
            },
            onAdditionalAssets(result: any) {
                for (const o of result.output) files.set(o.fileName, o.type === 'chunk' ? o.code : String(o.source));
            },
            onHmrUpdates(result: any) {
                if (result instanceof Error) {
                    options.log.error(result.message);
                    sendAll({ type: 'lunx:bundle-error', message: result.message });
                    return;
                }
                if (result.updates.length) rebuildLater();
                for (const { clientId, update } of result.updates) {
                    const client = clients.get(clientId);
                    if (!client) continue;
                    if (update.type === 'Patch') {
                        patches.set(`${clientId}/${update.filename}`, update.code);
                        if (update.sourcemap && update.sourcemapFilename) patches.set(`${clientId}/${update.sourcemapFilename}`, update.sourcemap);
                        client.send(JSON.stringify({ type: 'lunx:bundle-patch', url: `${BUNDLE_PREFIX}hmr/${clientId}/${update.filename}`, filename: update.filename, changedIds: update.changedIds }));
                    } else if (update.type === 'FullReload') {
                        client.send(JSON.stringify({ type: 'lunx:bundle-reload', reason: update.reason }));
                    }
                }
            },
        },
    );
    const started = Date.now();
    void engine.run().catch((err: Error) => {
        buildError = err.message;
        settle();
    });
    void ready.then(() => {
        if (!buildError) options.log.info(`bundled ${engine.moduleGraph.getModuleIds().length} modules in ${Date.now() - started} ms`);
    });

    async function current(): Promise<void> {
        await ready;
        const state = await engine.getBundleState();
        // After hot updates (or a failed build) the bundles on hand are behind the sources.
        if (state.hasStaleOutput || state.lastBuildErrored) await engine.ensureLatestBuildOutput().catch(() => {});
    }

    return {
        ready,
        rewriteHtml(html: string): string {
            return html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, before, src, after) => {
                const name = names.get(src);
                return name && /type=["']module["']/.test(before + after) ? `<script${before}src="${BUNDLE_PREFIX}${name}.js"${after}></script>` : tag;
            });
        },
        async serve(url: string) {
            const rel = decodeURIComponent(url.split('?')[0]!.slice(BUNDLE_PREFIX.length));
            if (rel.startsWith('hmr/')) {
                const body = patches.get(rel.slice(4));
                return body === undefined ? null : { body, type: rel.endsWith('.map') ? 'application/json' : 'application/javascript' };
            }
            await current();
            const body = files.get(rel);
            if (body === undefined) {
                if (buildError && rel.endsWith('.js')) {
                    // The page shows the error, and reloads once a save fixes it.
                    return { body: `${CLIENT_RUNTIME_STANDALONE}\n__lunx_bundle_error(${JSON.stringify(buildError)});`, type: 'application/javascript' };
                }
                return null;
            }
            return { body, type: rel.endsWith('.map') ? 'application/json' : rel.endsWith('.css') ? 'text/css' : 'application/javascript' };
        },
        attach(ws) {
            let id: string | null = null;
            ws.on('message', (data: any) => {
                let msg: any;
                try {
                    msg = JSON.parse(String(data));
                } catch {
                    return;
                }
                if (msg?.type === 'lunx:bundle-hello' && typeof msg.clientId === 'string') {
                    id = msg.clientId;
                    clients.set(id!, ws);
                    void engine.registerClient(id!).catch(() => {});
                    if (buildError) ws.send(JSON.stringify({ type: 'lunx:bundle-error', message: buildError }));
                } else if (msg?.type === 'lunx:bundle-delivered' && typeof msg.filename === 'string') {
                    void engine.notifyPayloadDelivered(msg.filename).catch(() => {});
                    if (id) {
                        patches.delete(`${id}/${msg.filename}`);
                        patches.delete(`${id}/${msg.filename}.map`);
                    }
                }
            });
            ws.on('close', () => {
                if (!id) return;
                clients.delete(id);
                for (const key of patches.keys()) if (key.startsWith(id + '/')) patches.delete(key);
                void engine.removeClient(id).catch(() => {});
            });
        },
        owns(file: string): boolean {
            return graph.has(file) || engine.moduleGraph.getModuleInfo(file) !== null || (CSS_LANGS.test(file) && inProject(file));
        },
        async close() {
            if (rebuildTimer) clearTimeout(rebuildTimer);
            await engine.close().catch(() => {});
        },
    };
}

/**
 * The browser side: Rolldown's dev runtime (prepended by Rolldown: the module
 * store and executor) plus lunx's HMR client. A patch registers factories for
 * the changed modules; the client walks their importers to the modules that
 * accept the update, disposes what it passes, re-runs them and refreshes React.
 */
const CLIENT_RUNTIME = String.raw`
const __lunx_hot = new Map();
const __lunx_overlay = (message) => {
  let el = document.getElementById('__lunx_bundle_error');
  if (message == null) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('pre');
    el.id = '__lunx_bundle_error';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;margin:0;padding:24px;overflow:auto;background:rgba(20,20,20,.95);color:#ff8080;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap';
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = '[lunx] ' + message;
};
class LunxHot {
  constructor(id) {
    this.id = id;
    this.data = __lunx_hot.get(id)?.data ?? {};
    this.selfAccept = null;
    this.depAccepts = [];
    this.disposers = [];
    this.pruners = [];
    this.declined = false;
  }
  accept(deps, cb) {
    if (typeof deps === 'function' || deps === undefined) this.selfAccept = deps || (() => {});
    else this.depAccepts.push({ deps: [].concat(deps), cb, many: Array.isArray(deps) });
  }
  acceptExports(_names, cb) { this.accept(cb); }
  dispose(cb) { this.disposers.push(cb); }
  prune(cb) { this.pruners.push(cb); }
  decline() { this.declined = true; }
  invalidate(message) {
    if (message) console.debug('[lunx] ' + message);
    __lunx_queue.push(() => __lunx_propagate(__lunx_runtime.getImporters(this.id), true));
  }
  on(event, cb) { addEventListener('lunx:' + event, (e) => cb(e.detail)); }
  off() {}
  send() {}
}
class LunxDevRuntime extends DevRuntime {}
const __lunx_runtime = (globalThis.__rolldown_runtime__ ??= new LunxDevRuntime(Math.random().toString(36).slice(2) + Date.now().toString(36)));
// Rolldown opens every module's code with createModuleHotContext(id), so while a module runs
// this is its id: React Refresh registrations are namespaced by it (two files' "App" stay apart).
let __lunx_current = '';
const __lunx_rr = () => window.__lunx_react_refresh__;
window.$RefreshReg$ = (type, name) => __lunx_rr()?.register(type, __lunx_current + ' ' + name);
window.$RefreshSig$ = () => (__lunx_rr() ? __lunx_rr().createSignatureFunctionForTransform() : (type) => type);
/** A module whose every export is a React component re-renders in place (as @vitejs/plugin-react's). */
function __lunx_refreshBoundary(id) {
  const rr = __lunx_rr();
  if (!rr || !__lunx_runtime.isExecuted(id)) return false;
  const exports = __lunx_runtime.loadExports(id);
  let any = false;
  for (const key in exports) {
    if (key === '__esModule') continue;
    any = true;
    if (!rr.isLikelyComponentType(exports[key])) return false;
  }
  return any;
}
__lunx_runtime.hooks = {
  createModuleHotContext(id) {
    __lunx_current = id;
    const hot = new LunxHot(id);
    __lunx_hot.set(id, hot);
    return hot;
  },
  onModuleCacheRemoval() {},
};
const __lunx_queue = [];
function __lunx_reload(why) {
  if (why) console.info('[lunx] ' + why + ', reloading');
  location.reload();
}
/** Hot-updates the modules in ids (patched or invalidated). */
function __lunx_propagate(ids, fromInvalidate) {
  const invalidated = new Set();
  const boundaries = new Set();
  const depBoundaries = [];
  const refreshed = new Set();
  const stack = ids.filter((id) => __lunx_runtime.isExecuted(id));
  if (fromInvalidate && !stack.length) return __lunx_reload('an updated module has no importer to accept it');
  while (stack.length) {
    const id = stack.pop();
    if (invalidated.has(id)) continue;
    invalidated.add(id);
    const hot = __lunx_hot.get(id);
    if (hot?.declined) return __lunx_reload(id + ' declines hot updates');
    if (hot?.selfAccept) { boundaries.add(id); continue; }
    if (__lunx_refreshBoundary(id)) { boundaries.add(id); refreshed.add(id); continue; }
    const importers = __lunx_runtime.getImporters(id).filter((i) => __lunx_runtime.isExecuted(i));
    if (!importers.length) return __lunx_reload(id + ' changed and nothing accepts it');
    for (const importer of importers) {
      const ih = __lunx_hot.get(importer);
      const accept = ih?.depAccepts.find((a) => a.deps.includes(id));
      if (accept) depBoundaries.push({ importer, accept, dep: id });
      else stack.push(importer);
    }
  }
  try {
    const previous = new Map();
    for (const id of invalidated) {
      const hot = __lunx_hot.get(id);
      if (hot) { previous.set(id, hot); for (const d of hot.disposers) d(hot.data); }
      __lunx_runtime.removeModuleCache(id);
    }
    for (const id of boundaries) {
      const exports = __lunx_runtime.initModule(id);
      if (refreshed.has(id) && !__lunx_refreshBoundary(id)) return __lunx_reload(id + ' no longer exports only components');
      previous.get(id)?.selfAccept?.(exports);
    }
    for (const { accept, dep } of depBoundaries) {
      const exports = __lunx_runtime.initModule(dep);
      if (!accept.cb) continue;
      accept.many ? accept.cb(accept.deps.map((d) => (d === dep ? exports : undefined))) : accept.cb(exports);
    }
  } catch (err) {
    console.error(err);
    return __lunx_reload(err && err.name === 'MissingFactoryError' ? 'a module outside the update needs to re-run' : 'a hot update failed');
  }
  while (__lunx_queue.length) __lunx_queue.shift()();
  if (window.__lunx_react_refresh__) {
    clearTimeout(window.__lunx_refresh_timer);
    window.__lunx_refresh_timer = setTimeout(() => window.__lunx_react_refresh__.performReactRefresh(), 0);
  }
}
(() => {
  if (typeof WebSocket === 'undefined' || globalThis.__lunx_bundle_socket) return;
  let updating = Promise.resolve();
  const connect = (retry) => {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/__lunx_hmr');
    globalThis.__lunx_bundle_socket = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'lunx:bundle-hello', clientId: __lunx_runtime.clientId }));
      if (retry) __lunx_reload('the dev server is back');
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'lunx:bundle-patch') {
        updating = updating.then(async () => {
          dispatchEvent(new CustomEvent('lunx:vite:beforeUpdate', { detail: { updates: msg.changedIds } }));
          await import(msg.url);
          ws.send(JSON.stringify({ type: 'lunx:bundle-delivered', filename: msg.filename }));
          __lunx_overlay(null);
          __lunx_propagate(msg.changedIds, false);
          dispatchEvent(new CustomEvent('lunx:vite:afterUpdate', { detail: { updates: msg.changedIds } }));
        }).catch((err) => { console.error(err); __lunx_reload('a hot update failed'); });
      } else if (msg.type === 'lunx:bundle-reload' || msg.type === 'full-reload') {
        __lunx_reload(msg.reason || 'the page changed');
      } else if (msg.type === 'lunx:bundle-error') {
        console.error('[lunx] ' + msg.message);
        __lunx_overlay(msg.message);
      } else if (msg.type === 'lunx:bundle-ok') {
        __lunx_overlay(null);
      }
    });
    ws.addEventListener('close', () => setTimeout(() => connect(true), 1000));
  };
  connect(false);
})();
`;

/** For a page whose first build failed: the overlay, and a reload once a save fixes the build. */
const CLIENT_RUNTIME_STANDALONE = String.raw`
function __lunx_bundle_error(message) {
  const show = () => {
    const el = document.createElement('pre');
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;margin:0;padding:24px;overflow:auto;background:rgba(20,20,20,.95);color:#ff8080;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap';
    el.textContent = '[lunx] ' + message;
    (document.body || document.documentElement).appendChild(el);
  };
  document.body ? show() : addEventListener('DOMContentLoaded', show);
  const poll = () => fetch(import.meta.url, { cache: 'no-store' }).then((r) => r.text()).then((t) => (t.includes('__lunx_bundle_error(') ? setTimeout(poll, 1000) : location.reload()), () => setTimeout(poll, 1000));
  setTimeout(poll, 1000);
}
`;
