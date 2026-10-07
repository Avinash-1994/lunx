/**
 * Module federation on lunx's engine. A plugin for the production bundle plus
 * the remoteEntry writer that runs after it:
 *
 *  - Shared packages: every import of one goes through a small CommonJS proxy
 *    that hands out the copy the share scope picked; the app's own copy sits
 *    in a separate chunk, loaded only when the scope chooses it.
 *  - Remotes: `import x from 'cart/Widget'` becomes a proxy filled by a preload
 *    that runs before the importing module; `import('cart/Widget')` loads it
 *    through the runtime.
 *  - Exposes: each exposed module is an entry; remoteEntry.js is an ES module
 *    exporting webpack's container API (init / get).
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { runtimeSource, type RuntimeShared } from './runtime-source.js';

export interface SharedOptions {
    singleton?: boolean;
    requiredVersion?: string | false;
    strictVersion?: boolean;
    eager?: boolean;
    version?: string;
}

export interface FederationOptions {
    name: string;
    filename?: string;
    exposes?: Record<string, string>;
    remotes?: Record<string, string>;
    shared?: string[] | Record<string, SharedOptions | boolean | string>;
}

const RUNTIME = 'lunx-mf:runtime';
const INIT = 'lunx-mf:init';
const P = '\0lunx-mf:';

export const EXPOSE_PREFIX = '__mf_expose_';
export const RUNTIME_ENTRY = '__mf_runtime';

function readJson(file: string): any {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/** The installed version of `pkg` as seen from `root`. */
function installedVersion(root: string, pkg: string): string | null {
    for (let dir = root; ; dir = path.dirname(dir)) {
        const json = readJson(path.join(dir, 'node_modules', pkg, 'package.json'));
        if (json?.version) return json.version;
        if (path.dirname(dir) === dir) return null;
    }
}

export function normalizeShared(root: string, shared: FederationOptions['shared']): Record<string, RuntimeShared> {
    const pkgJson = readJson(path.join(root, 'package.json')) ?? {};
    const declared: Record<string, string> = { ...pkgJson.peerDependencies, ...pkgJson.devDependencies, ...pkgJson.dependencies };
    const list: Array<[string, SharedOptions]> = Array.isArray(shared)
        ? shared.map((n) => [n, {}])
        : Object.entries(shared ?? {}).map(([n, v]) => [n, typeof v === 'string' ? { requiredVersion: v } : v === true || v === false ? {} : v]);
    const out: Record<string, RuntimeShared> = {};
    for (const [name, opts] of list) {
        const version = opts.version ?? installedVersion(root, name) ?? '0.0.0';
        out[name] = {
            version,
            requiredVersion: opts.requiredVersion ?? declared[name] ?? `^${version}`,
            singleton: !!opts.singleton,
            strictVersion: !!opts.strictVersion,
            eager: !!opts.eager,
        };
    }
    return out;
}

/** `name@url` (webpack) or a plain URL → the URL. */
export function remoteUrl(spec: string): string {
    const at = /^[A-Za-z0-9_$.-]+@(.+)$/.exec(spec);
    return at ? at[1]! : spec;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function exposeEntryName(key: string): string {
    return EXPOSE_PREFIX + (key.replace(/^\.\/?/, '').replace(/[^A-Za-z0-9_$]/g, '_') || 'index');
}

/**
 * The bundle plugin. `entries` are the app's own entry files (they wait for
 * the share scope before running).
 */
export function federationEnginePlugin(options: FederationOptions, root: string, entries: Set<string>): any {
    const shared = normalizeShared(root, options.shared);
    const sharedNames = Object.keys(shared);
    const remotes = options.remotes ?? {};
    const remoteNames = Object.keys(remotes);
    const remoteRe = remoteNames.length ? `(?:${remoteNames.map(escapeRe).join('|')})(?:/[^'"\`]*)?` : null;
    const dynamicRe = remoteRe ? new RegExp(`\\bimport\\(\\s*(['"\`])(${remoteRe})\\1\\s*\\)`, 'g') : null;
    const staticRe = remoteRe ? new RegExp(`(?:\\bfrom|\\bimport)\\s*(['"])(${remoteRe})\\1`, 'g') : null;
    const isRemote = (id: string) => remoteNames.some((n) => id === n || id.startsWith(n + '/'));

    return {
        name: 'lunx:federation',
        async resolveId(id: string, importer: string | undefined, extra: any) {
            if (id === RUNTIME || id === INIT) return P + id.slice('lunx-mf:'.length);
            if (id.startsWith('lunx-mf-real:')) return P + 'real:' + id.slice('lunx-mf-real:'.length);
            if (id.startsWith('lunx-mf-preload:')) return P + 'preload:' + id.slice('lunx-mf-preload:'.length);
            if (importer?.startsWith(P + 'real:')) {
                // The real package behind a shared proxy.
                return this.resolve(id, path.join(root, 'package.json'), { ...extra, skipSelf: true });
            }
            if (shared[id]) return P + 'shared:' + id;
            if (isRemote(id) && !importer?.startsWith(P)) return P + 'remote:' + id;
            return null;
        },
        load(id: string) {
            if (!id.startsWith(P)) return null;
            const rest = id.slice(P.length);
            if (rest === 'runtime') return { code: runtimeSource(options.name, shared, remotes), moduleType: 'js' };
            if (rest === 'init') return { code: `import { ensureShared } from ${JSON.stringify(RUNTIME)};\nawait ensureShared();\n`, moduleType: 'js' };
            const [kind, spec] = [rest.slice(0, rest.indexOf(':')), rest.slice(rest.indexOf(':') + 1)];
            // A factory, so loading the chunk does not evaluate the package yet.
            if (kind === 'real') return { code: `export default function () { return require(${JSON.stringify(spec)}); }\n`, moduleType: 'js' };
            if (kind === 'shared') return { code: `module.exports = require(${JSON.stringify(RUNTIME)}).__shared(${JSON.stringify(spec)});\n`, moduleType: 'js' };
            if (kind === 'remote') return { code: `module.exports = require(${JSON.stringify(RUNTIME)}).__remote(${JSON.stringify(spec)});\n`, moduleType: 'js' };
            if (kind === 'preload') return { code: `import { loadRemote } from ${JSON.stringify(RUNTIME)};\nawait loadRemote(${JSON.stringify(spec)});\n`, moduleType: 'js' };
            return null;
        },
        transform: {
            filter: { id: { include: /\.(vue|svelte|[mc]?[jt]sx?)(\?.*)?$/, exclude: /node_modules/ } },
            handler(code: string, id: string) {
                const file = id.split('?')[0]!;
                const prefix: string[] = [];
                if (entries.has(file) && sharedNames.length) prefix.push(`import ${JSON.stringify(INIT)};`);
                let out = code;
                if (staticRe && dynamicRe) {
                    const preloads = new Set<string>();
                    for (const m of code.matchAll(staticRe)) {
                        const before = code.slice(Math.max(0, m.index! - 12), m.index);
                        if (!/\bimport\s+type\s*$/.test(before) && !/\btype\s*$/.test(before)) preloads.add(m[2]!);
                    }
                    let dynamic = false;
                    out = out.replace(dynamicRe, (_m, _q, spec) => {
                        dynamic = true;
                        return `__lunx_mf_load(${JSON.stringify(spec)})`;
                    });
                    for (const spec of preloads) prefix.push(`import ${JSON.stringify('lunx-mf-preload:' + spec)};`);
                    if (dynamic) prefix.push(`import { loadRemote as __lunx_mf_load } from ${JSON.stringify(RUNTIME)};`);
                }
                if (!prefix.length && out === code) return null;
                // One line, so the module's own line numbers stay put.
                return { code: prefix.join(' ') + out, map: null };
            },
        },
    };
}

/** Extra bundle inputs: each exposed module, and the runtime the container uses. */
export function federationInputs(options: FederationOptions, root: string): Record<string, string> {
    const input: Record<string, string> = {};
    if (!options.exposes || !Object.keys(options.exposes).length) return input;
    for (const [key, file] of Object.entries(options.exposes)) input[exposeEntryName(key)] = path.resolve(root, file);
    input[RUNTIME_ENTRY] = RUNTIME;
    return input;
}

/**
 * Write remoteEntry.js (an ES module container) and mf-manifest.json next to
 * the build output. `chunks` maps entry names to output file names.
 */
export async function writeRemoteEntry(
    options: FederationOptions,
    root: string,
    outDir: string,
    chunks: Map<string, string>,
    cssFiles: string[],
): Promise<{ fileName: string; code: string } | null> {
    if (!options.exposes || !Object.keys(options.exposes).length) return null;
    const fileName = (options.filename ?? 'remoteEntry.js').replace(/\.json$/, '.js');
    const rel = (f: string) => {
        const r = path.posix.relative(path.posix.dirname(fileName), f);
        return r.startsWith('.') ? r : `./${r}`;
    };
    const runtime = chunks.get(RUNTIME_ENTRY);
    if (!runtime) throw new Error('[lunx mf] the federation runtime chunk is missing from the build');
    const exposes: Record<string, string> = {};
    const lines = Object.keys(options.exposes).map((key) => {
        const chunk = chunks.get(exposeEntryName(key));
        if (!chunk) throw new Error(`[lunx mf] exposed module ${key} produced no chunk`);
        exposes[key] = chunk;
        return `    ${JSON.stringify(key)}: () => import(${JSON.stringify(rel(chunk))}),`;
    });
    const code = `// lunx module federation container: ${options.name}
import { init as __init, ensureShared } from ${JSON.stringify(rel(runtime))};

const exposes = {
${lines.join('\n')}
};
const css = ${JSON.stringify(cssFiles.map(rel))};
let cssLoaded = false;

function loadCss() {
    if (cssLoaded || typeof document === 'undefined') return;
    cssLoaded = true;
    for (const file of css) {
        const href = new URL(file, import.meta.url).href;
        if (document.querySelector('link[href="' + href + '"]')) continue;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
    }
}

export const name = ${JSON.stringify(options.name)};

export function init(shareScope) {
    return __init(shareScope);
}

export async function get(request) {
    const load = exposes[request] || exposes['./' + String(request).replace(/^\\.?\\//, '')];
    if (!load) throw new Error('[lunx mf] module "' + request + '" is not exposed by ${options.name}; exposed: ' + Object.keys(exposes).join(', '));
    await ensureShared();
    loadCss();
    const mod = await load();
    return () => mod;
}

export default { name, init, get };
`;
    await fsp.mkdir(path.dirname(path.join(outDir, fileName)), { recursive: true });
    await fsp.writeFile(path.join(outDir, fileName), code);
    const manifest = {
        name: options.name,
        remoteEntry: fileName,
        exposes,
        remotes: Object.fromEntries(Object.entries(options.remotes ?? {}).map(([k, v]) => [k, remoteUrl(v)])),
        shared: normalizeShared(root, options.shared),
        css: cssFiles,
    };
    await fsp.writeFile(path.join(outDir, 'mf-manifest.json'), JSON.stringify(manifest, null, 2));
    return { fileName, code };
}
