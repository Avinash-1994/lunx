/**
 * Source of the browser runtime every federated build carries (served as the
 * virtual module `lunx-mf:runtime`). It keeps the share scope in webpack 5's
 * format — scope[pkg][version] = { get, from, eager, loaded } — so lunx
 * containers and webpack containers can share one scope.
 */

export interface RuntimeShared {
    version: string;
    requiredVersion: string | false;
    singleton: boolean;
    strictVersion: boolean;
    eager: boolean;
}

export function runtimeSource(name: string, shared: Record<string, RuntimeShared>, remotes: Record<string, string>): string {
    const getters = Object.keys(shared)
        .map((pkg) => `${JSON.stringify(pkg)}: () => import(${JSON.stringify(`lunx-mf-real:${pkg}`)}).then((m) => m.default)`)
        .join(',\n    ');
    return `
const NAME = ${JSON.stringify(name)};
const SHARED = ${JSON.stringify(shared)};
const GET = {
    ${getters}
};
const REMOTES = ${JSON.stringify(remotes)};
const g = globalThis;
const scopes = g.__lunx_mf_scopes__ || (g.__lunx_mf_scopes__ = { default: {} });
let scope = scopes.default;
const resolved = Object.create(null);
const factories = Object.create(null);
const remoteModules = Object.create(null);
const containers = Object.create(null);
let registered = false;
let ready = null;

function parse(v) {
    const m = /^v?(\\d+)(?:\\.(\\d+|[xX*]))?(?:\\.(\\d+|[xX*]))?/.exec(String(v).trim());
    if (!m) return null;
    const n = (s) => (s === undefined || /[xX*]/.test(s) ? undefined : Number(s));
    return [Number(m[1]), n(m[2]), n(m[3])];
}
function cmp(a, b) {
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
    return 0;
}
function test(v, comp) {
    comp = comp.trim();
    if (!comp || comp === '*' || /^[xX]$/.test(comp) || comp === 'latest') return true;
    const op = /^(\\^|~|>=|<=|>|<|=)?\\s*(.*)$/.exec(comp);
    const p = parse(op[2]);
    if (!p) return false;
    const lo = [p[0], p[1] || 0, p[2] || 0];
    switch (op[1]) {
        case '>=': return cmp(v, lo) >= 0;
        case '>': return cmp(v, lo) > 0;
        case '<=': return cmp(v, lo) <= 0;
        case '<': return cmp(v, lo) < 0;
        case '^': {
            const hi = lo[0] > 0 || p[1] === undefined ? [lo[0] + 1, 0, 0] : lo[1] > 0 || p[2] === undefined ? [0, lo[1] + 1, 0] : [0, 0, lo[2] + 1];
            return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
        }
        case '~': {
            const hi = p[1] === undefined ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0];
            return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
        }
        default: {
            if (p[1] === undefined) return v[0] === p[0];
            if (p[2] === undefined) return v[0] === p[0] && v[1] === p[1];
            return cmp(v, lo) === 0;
        }
    }
}
export function satisfies(version, range) {
    const v = parse(version);
    if (!v || !range) return !!v || !range;
    return String(range).split('||').some((alt) => {
        const hy = /^\\s*(\\S+)\\s+-\\s+(\\S+)\\s*$/.exec(alt);
        const comps = hy ? ['>=' + hy[1], '<=' + hy[2]] : alt.trim().split(/\\s+/).filter(Boolean);
        return comps.every((c) => test(v, c));
    });
}

function register() {
    if (registered) return;
    registered = true;
    for (const pkg of Object.keys(SHARED)) {
        const s = SHARED[pkg];
        const versions = scope[pkg] || (scope[pkg] = {});
        if (!versions[s.version]) versions[s.version] = { get: GET[pkg], from: NAME, eager: s.eager, loaded: 0 };
    }
}

/** Join a share scope (a host passes its own; webpack hosts pass __webpack_share_scopes__.default). */
export function init(shareScope) {
    if (shareScope && shareScope !== scope) {
        for (const pkg of Object.keys(scope)) {
            const target = shareScope[pkg] || (shareScope[pkg] = {});
            for (const v of Object.keys(scope[pkg])) if (!target[v]) target[v] = scope[pkg][v];
        }
        scope = scopes.default = shareScope;
    }
    register();
}

function pick(pkg) {
    const s = SHARED[pkg];
    const versions = scope[pkg] || {};
    const list = Object.keys(versions).filter((v) => parse(v)).sort((a, b) => cmp(parse(b), parse(a)));
    if (s.singleton) {
        const loaded = list.find((v) => versions[v].loaded);
        const v = loaded || list[0] || s.version;
        if (s.requiredVersion && !satisfies(v, s.requiredVersion)) {
            const msg = '[lunx mf] ' + NAME + ': shared singleton "' + pkg + '" is ' + v + ' but ' + s.requiredVersion + ' is required';
            if (s.strictVersion) throw new Error(msg);
            console.warn(msg);
        }
        return versions[v];
    }
    const v = list.find((x) => !s.requiredVersion || satisfies(x, s.requiredVersion));
    return versions[v] || versions[s.version];
}

// Fetch now, evaluate on first use: a shared package that requires another
// one (react-dom → react) finds it ready whatever order they arrive in.
async function loadShared(pkg) {
    const entry = pick(pkg);
    if (!entry.__lunx_factory) entry.__lunx_factory = Promise.resolve(entry.get());
    const factory = await entry.__lunx_factory;
    factories[pkg] = () => {
        if (!('__lunx_module' in entry)) {
            entry.loaded = 1;
            entry.__lunx_module = typeof factory === 'function' ? factory() : factory;
        }
        return entry.__lunx_module;
    };
}

/** Settle every shared module before code that imports one runs. */
export function ensureShared() {
    register();
    return ready || (ready = Promise.all(Object.keys(SHARED).map(loadShared)));
}

export function __shared(pkg) {
    if (pkg in resolved) return resolved[pkg];
    if (factories[pkg]) return (resolved[pkg] = factories[pkg]());
    throw new Error('[lunx mf] ' + NAME + ': shared module "' + pkg + '" was used before the share scope was ready');
}

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('[lunx mf] failed to load ' + url));
        document.head.appendChild(s);
    });
}

function container(name) {
    if (containers[name]) return containers[name];
    const spec = REMOTES[name];
    if (!spec) return Promise.reject(new Error('[lunx mf] unknown remote "' + name + '"; configured: ' + Object.keys(REMOTES).join(', ')));
    const at = /^([A-Za-z0-9_$.-]+)@(.+)$/.exec(spec);
    const global = at ? at[1] : name;
    const url = at ? at[2] : spec;
    return (containers[name] = (async () => {
        let c = null;
        try {
            const m = await import(/* @vite-ignore */ url);
            if (m && typeof m.get === 'function') c = m;
            else if (m && m.default && typeof m.default.get === 'function') c = m.default;
        } catch (err) {
            if (typeof document === 'undefined') throw err;
        }
        if (!c) c = g[global];
        if (!c && typeof document !== 'undefined') {
            await loadScript(url);
            c = g[global];
        }
        if (!c || typeof c.get !== 'function') throw new Error('[lunx mf] ' + url + ' is not a module federation container');
        await ensureShared();
        await c.init(scope);
        return c;
    })());
}

function asExports(m) {
    if (!m || typeof m !== 'object' || m.__esModule) return m;
    if (m[Symbol.toStringTag] !== 'Module') return m;
    const out = { __esModule: true };
    for (const k of Object.keys(m)) out[k] = m[k];
    return out;
}

/** import('remote/Module'): the exposed module's exports. */
export async function loadRemote(id) {
    if (id in remoteModules) return remoteModules[id];
    const slash = id.indexOf('/');
    const name = slash < 0 ? id : id.slice(0, slash);
    const exposed = slash < 0 ? '.' : './' + id.slice(slash + 1);
    const factory = await (await container(name)).get(exposed);
    return (remoteModules[id] = typeof factory === 'function' ? await factory() : factory);
}

export function __remote(id) {
    if (!(id in remoteModules)) throw new Error('[lunx mf] ' + NAME + ': remote module "' + id + '" was used before it loaded');
    return asExports(remoteModules[id]);
}

export function preloadRemote(name) {
    return container(name);
}
`;
}
