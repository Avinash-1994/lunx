/**
 * Module federation in the dev server, with the same runtime and container
 * API as production builds (src/federation/engine.ts), so a dev host can load
 * built remotes and a built host can load dev remotes.
 *
 * URLs it serves:
 *   /@lunx-mf/runtime.js          the runtime (share scope, remote loading)
 *   /@lunx-mf/shared/<pkg>.js     a shared package, as the share scope picked it
 *   /@lunx-mf/remote/<id>.js      an exposed module of a remote ('cart/Widget')
 *   /<filename>                   this app's container, when it exposes modules
 */

import fs from 'fs';
import path from 'path';
import type http from 'http';
import { parse } from '../engines/index.js';
import { normalizeShared, type FederationOptions } from './engine.js';
import { runtimeSource, type RuntimeShared } from './runtime-source.js';

const RUNTIME_URL = '/@lunx-mf/runtime.js';
const SHARED_URL = '/@lunx-mf/shared/';
const REMOTE_URL = '/@lunx-mf/remote/';

export interface DevFederationContext {
    root: string;
    /** Wait for dependency pre-bundling, then return spec → URL of each bundled dep. */
    deps(): Promise<Map<string, string>>;
    /** Directory the pre-bundled files are written to. */
    depsDir: string;
}

const safeName = (spec: string) => spec.replace(/[/@]/g, '_');

/** Names an ES module exports (its `export` statements, not `export *`). */
export function exportNames(file: string, code: string): string[] {
    const names = new Set<string>();
    let program: any;
    try {
        program = parse(file, code, 'js');
    } catch {
        return [];
    }
    for (const node of program.body) {
        if (node.type !== 'ExportNamedDeclaration') continue;
        for (const s of node.specifiers ?? []) names.add(s.exported?.name ?? s.exported?.value);
        const decl = node.declaration;
        if (!decl) continue;
        if (decl.type === 'VariableDeclaration') {
            for (const d of decl.declarations) if (d.id?.type === 'Identifier') names.add(d.id.name);
        } else if (decl.id?.name) {
            names.add(decl.id.name);
        }
    }
    names.delete('default');
    names.delete(undefined as any);
    return [...names];
}

export class DevFederation {
    readonly shared: Record<string, RuntimeShared>;
    private readonly remoteNames: string[];
    private readonly fileName: string;
    private nextId = 0;

    constructor(private options: FederationOptions, private ctx: DevFederationContext) {
        this.shared = normalizeShared(ctx.root, options.shared);
        this.remoteNames = Object.keys(options.remotes ?? {});
        this.fileName = '/' + (options.filename ?? 'remoteEntry.js').replace(/\.json$/, '.js').replace(/^\/+/, '');
    }

    isRemote(spec: string): boolean {
        return this.remoteNames.some((n) => spec === n || spec.startsWith(n + '/'));
    }

    isShared(spec: string): boolean {
        return spec in this.shared;
    }

    sharedUrl(spec: string): string {
        return `${SHARED_URL}${safeName(spec)}.js`;
    }

    remoteUrl(spec: string): string {
        return `${REMOTE_URL}${spec}.js`;
    }

    /** `import('cart/Widget')` → the module, through the runtime. */
    rewriteDynamic(code: string): string {
        if (!this.remoteNames.length) return code;
        const names = this.remoteNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const re = new RegExp(`\\bimport\\(\\s*(['"\`])((?:${names})(?:/[^'"\`]*)?)\\1\\s*\\)`, 'g');
        return code.replace(re, (_m, _q, spec) => `import(${JSON.stringify(this.remoteUrl(spec))}).then((n) => n.default)`);
    }

    /**
     * An import declaration from a remote, as code: the remote's module comes
     * from its proxy (whose default is the whole module), bindings read from it.
     */
    rewriteImportDeclaration(node: any): string {
        const spec = node.source.value as string;
        const ns = `__lunx_mf_${this.nextId++}`;
        let head = `import ${ns}`;
        const lines: string[] = [];
        for (const s of node.specifiers ?? []) {
            if (s.type === 'ImportDefaultSpecifier') head += `, { __default as ${s.local.name} }`;
            else if (s.type === 'ImportNamespaceSpecifier') lines.push(`const ${s.local.name} = ${ns};`);
            else lines.push(`const ${s.local.name} = ${ns}[${JSON.stringify(s.imported?.name ?? s.imported?.value)}];`);
        }
        return `${head} from ${JSON.stringify(this.remoteUrl(spec))}; ${lines.join(' ')}`;
    }

    /** Serve the federation URLs; false for any other request. */
    async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
        const url = (req.url ?? '').split('?')[0]!;
        let code: string | null = null;
        if (url === RUNTIME_URL) code = await this.runtime();
        else if (url.startsWith(SHARED_URL)) code = await this.sharedModule(url.slice(SHARED_URL.length).replace(/\.js$/, ''));
        else if (url.startsWith(REMOTE_URL)) code = this.remoteModule(decodeURIComponent(url.slice(REMOTE_URL.length).replace(/\.js$/, '')));
        else if (url === this.fileName && this.options.exposes && Object.keys(this.options.exposes).length) code = this.container();
        if (code === null) return false;
        res.writeHead(200, {
            'Content-Type': 'application/javascript',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(code);
        return true;
    }

    private async runtime(): Promise<string> {
        const deps = await this.ctx.deps();
        return runtimeSource(this.options.name, this.shared, this.options.remotes ?? {}, (pkg) => {
            const url = deps.get(pkg) ?? `/@lunx-deps/${safeName(pkg)}.js`;
            return `() => import(${JSON.stringify(url)}).then((m) => () => m)`;
        });
    }

    private async sharedModule(safe: string): Promise<string | null> {
        const pkg = Object.keys(this.shared).find((p) => safeName(p) === safe);
        if (!pkg) return null;
        await this.ctx.deps();
        const file = path.join(this.ctx.depsDir, `${safe}.js`);
        const names = fs.existsSync(file) ? exportNames(file, fs.readFileSync(file, 'utf8')) : [];
        return [
            `import { ensureShared, __shared } from ${JSON.stringify(RUNTIME_URL)};`,
            'await ensureShared();',
            `const m = __shared(${JSON.stringify(pkg)});`,
            `export default m && (m[Symbol.toStringTag] === 'Module' || m.__esModule) ? m.default : m;`,
            ...names.map((n, i) => `const __e${i} = m[${JSON.stringify(n)}]; export { __e${i} as ${/^[A-Za-z_$][\w$]*$/.test(n) ? n : JSON.stringify(n)} };`),
        ].join('\n');
    }

    private remoteModule(id: string): string {
        return [
            `import { loadRemote } from ${JSON.stringify(RUNTIME_URL)};`,
            `const m = await loadRemote(${JSON.stringify(id)});`,
            'export default m;',
            `export const __default = m && (m[Symbol.toStringTag] === 'Module' || m.__esModule) ? m.default : m;`,
        ].join('\n');
    }

    private container(): string {
        const exposes = Object.entries(this.options.exposes ?? {}).map(([key, file]) => {
            const rel = path.relative(this.ctx.root, path.resolve(this.ctx.root, file)).split(path.sep).join('/');
            return `    ${JSON.stringify(key)}: () => import(${JSON.stringify('/' + rel)}),`;
        });
        return `// lunx module federation container (dev): ${this.options.name}
import { init as __init, ensureShared } from ${JSON.stringify(RUNTIME_URL)};

const exposes = {
${exposes.join('\n')}
};

export const name = ${JSON.stringify(this.options.name)};

export function init(shareScope) {
    return __init(shareScope);
}

// Its modules carry React Refresh registrations; a page without the dev
// preamble (a production host) gets no-ops.
if (typeof globalThis.$RefreshReg$ === 'undefined') {
    globalThis.$RefreshReg$ = () => {};
    globalThis.$RefreshSig$ = () => (type) => type;
}

export async function get(request) {
    const load = exposes[request] || exposes['./' + String(request).replace(/^\\.?\\//, '')];
    if (!load) throw new Error('[lunx mf] module "' + request + '" is not exposed by ${this.options.name}; exposed: ' + Object.keys(exposes).join(', '));
    await ensureShared();
    const mod = await load();
    return () => mod;
}

export default { name, init, get };
`;
    }
}
