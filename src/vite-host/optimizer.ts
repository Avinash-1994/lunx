/**
 * Dependency pre-bundling for the browser, Vite's model: bare imports that
 * land in node_modules are bundled once with Rolldown into
 * node_modules/.vite/deps (CommonJS gets ESM named exports, shared code goes
 * to common chunks so React exists once), and served from there. The source
 * is scanned up front; a dependency found later triggers a re-bundle and a
 * full reload, as in Vite.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { getBundler, parse } from '../engines/index.js';
import { createResolver } from '../engines/toolkit.js';
import { arraify, mergeConfig, normalizePath } from './utils.js';
import { getPackageName } from './plugins/resolve.js';

const require = createRequire(import.meta.url);
const RESERVED = new Set(['default', '__esModule', 'arguments', 'eval', 'await', 'yield', 'let', 'static', 'enum', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with']);
const SCAN_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.svelte-kit', '.react-router', '.nuxt', '.output', '.vite', 'coverage']);
const SOURCE_RE = /\.(m?[jt]sx?|vue|svelte|astro)$/;
/** vite.config.ts, tailwind.config.js…: Node-side code, not browser dependencies. */
const CONFIG_RE = /\.config\.[cm]?[jt]s$|^(app|svelte|astro|nuxt|vite)\.config\./;

function isEsm(file: string, source: string): boolean {
    if (/\.mjs$/.test(file)) return true;
    if (/\.cjs$/.test(file)) return false;
    try {
        return parse(file, source, 'js').body.some((n: any) => /^(Import|Export)/.test(n.type));
    } catch {
        return false;
    }
}

/**
 * Evaluate a CommonJS module with `require` resolved under the environment's
 * conditions (Node's own require ignores them: React's react-server build).
 */
function evaluateCjs(file: string, resolveRequire: (spec: string, dir: string) => string | null, loaded = new Map<string, { exports: any }>()): any {
    const done = loaded.get(file);
    if (done) return done.exports;
    if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (file.endsWith('.node') || file.endsWith('.mjs')) return require(file);
    const module = { exports: {} as any };
    loaded.set(file, module);
    const dir = path.dirname(file);
    const req: any = (spec: string) => {
        if (builtinModules.includes(spec.replace(/^node:/, '')) || spec.startsWith('node:')) return require(spec);
        const target = resolveRequire(spec, dir);
        if (!target) throw new Error(`Cannot find module '${spec}'`);
        return evaluateCjs(target, resolveRequire, loaded);
    };
    req.resolve = (spec: string) => resolveRequire(spec, dir) ?? spec;
    new Function('exports', 'require', 'module', '__filename', '__dirname', fs.readFileSync(file, 'utf-8'))(module.exports, req, module, file, dir);
    return module.exports;
}

function cjsExportNames(file: string, source: string, resolveRequire?: (spec: string, dir: string) => string | null): string[] {
    let keys: string[] = [];
    try {
        const mod = resolveRequire ? evaluateCjs(file, resolveRequire) : require(file);
        if (mod && (typeof mod === 'object' || typeof mod === 'function')) keys = Object.keys(mod);
    } catch {
        for (const m of source.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=|Object\.defineProperty\(\s*(?:module\.)?exports\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/g)) keys.push((m[1] ?? m[2])!);
    }
    return [...new Set(keys)].filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k));
}

/** The package directory containing a resolved file. */
function packageDir(file: string): string {
    let dir = path.dirname(file);
    while (!fs.existsSync(path.join(dir, 'package.json')) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    return dir;
}

export function flattenId(spec: string): string {
    return spec.replace(/[/:]/g, '_').replace(/\./g, '__').replace(/(\s*>\s*)/g, '___');
}

export class DepsOptimizer {
    readonly deps = new Map<string, string>();
    version = '';
    private building: Promise<void> | null = null;
    private dirty = false;
    private served = false;
    private timer: NodeJS.Timeout | null = null;
    readonly depsDir: string;
    readonly depsUrl: string;

    /** Top-level optimizeDeps merged with the client environment's (Vite 6). */
    private readonly options: Record<string, any>;

    private readonly envName: string;
    private readonly isClient: boolean;

    constructor(private config: any, private resolve: (spec: string, fromDir?: string) => string | null, private onReload: () => void, envName = 'client') {
        this.envName = envName;
        this.isClient = envName === 'client';
        // Client: top-level optimizeDeps + the environment's. Server environments (Vite 6): only
        // their own, and only listed dependencies (no discovery), e.g. React with react-server for RSC.
        this.options = this.isClient
            ? mergeConfig(config.optimizeDeps ?? {}, config.environments?.client?.optimizeDeps ?? {})
            : { ...config.environments?.[envName]?.optimizeDeps, noDiscovery: true };
        this.depsDir = path.join(config.cacheDir, this.isClient ? 'deps' : `deps_${envName}`);
        const rel = path.relative(config.root, this.depsDir);
        this.depsUrl = rel.startsWith('..') ? `/@fs/${normalizePath(this.depsDir).replace(/^\//, '')}` : '/' + normalizePath(rel);
    }

    private exclude(spec: string): boolean {
        const pkg = getPackageName(spec);
        return arraify(this.options.exclude ?? []).some((e: string) => e === pkg || e === spec || spec.startsWith(e + '/'));
    }

    /** Should this bare import be served pre-bundled? */
    shouldOptimize(spec: string, resolved: string): boolean {
        if (this.options.noDiscovery && !this.deps.has(spec)) return false;
        return this.optimizable(spec, resolved);
    }

    private optimizable(spec: string, resolved: string): boolean {
        if (!/[\\/]node_modules[\\/]/.test(resolved) || !/\.(m|c)?jsx?$/.test(resolved)) return false;
        return !this.exclude(spec);
    }

    private _requireResolver?: (spec: string, dir: string) => string | null;

    /** `require()` resolution under this environment's conditions. */
    private requireResolver(): (spec: string, dir: string) => string | null {
        if (!this._requireResolver) {
            const r = this.config.environments[this.envName].resolve;
            const resolver = createResolver({
                conditionNames: [...r.conditions.filter((c: string) => c !== 'module' && c !== 'import'), 'require', 'default'],
                mainFields: ['main'],
                extensions: ['.js', '.cjs', '.json', '.node'],
            });
            this._requireResolver = (spec, dir) => resolver.resolve(dir, spec);
        }
        return this._requireResolver;
    }

    /** The optimized dependency an import lands on: by name, or by resolved file (aliased imports). */
    lookup(spec: string, resolved: string): string | undefined {
        if (this.deps.has(spec)) return spec;
        for (const [name, file] of this.deps) if (file === resolved) return name;
        return undefined;
    }

    isOptimizedFile(file: string): boolean {
        return file.startsWith(this.depsDir + path.sep);
    }

    private initPromise: Promise<void> | null = null;

    /** Scan and pre-bundle in the background; the first optimized import waits for it. */
    start(): void {
        this.initPromise ??= this.init().catch((err) => this.config.logger.error(`[lunx] dependency pre-bundling failed: ${err.message}`));
    }

    private async init(): Promise<void> {
        for (const spec of arraify(this.options.include ?? [])) this.add(spec);
        if (!this.options.noDiscovery) for (const spec of this.scan()) this.add(spec);
        if (this.deps.size) await this.build();
    }

    private add(entry: string): boolean {
        // Vite's nested include: "a > b" is `b` as `a` resolves it.
        const chain = entry.split('>').map((p) => p.trim()).filter(Boolean);
        const spec = chain.pop()!;
        let fromDir: string | undefined;
        for (const parent of chain) {
            const parentFile = this.resolve(parent, fromDir);
            if (!parentFile) return false;
            fromDir = packageDir(parentFile);
        }
        if (this.deps.has(spec) || builtinModules.includes(spec) || spec.startsWith('node:')) return false;
        const resolved = this.resolve(spec, fromDir);
        if (!resolved || !this.optimizable(spec, resolved)) return false;
        this.deps.set(spec, resolved);
        return true;
    }

    /** Bare imports in the project's own source files. */
    private scan(): Set<string> {
        const found = new Set<string>();
        const walk = (dir: string, depth: number) => {
            if (depth > 12) return;
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (entry.name.startsWith('.') && entry.name !== '.') continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!SCAN_SKIP.has(entry.name)) walk(full, depth + 1);
                } else if (SOURCE_RE.test(entry.name) && !CONFIG_RE.test(entry.name)) {
                    const code = fs.readFileSync(full, 'utf-8');
                    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"./][^'"]*)['"]/g)) {
                        const spec = m[1]!;
                        if (!spec.startsWith('#') && !spec.startsWith('$') && !spec.startsWith('virtual:') && !spec.includes(':')) found.add(spec);
                    }
                }
            }
        };
        walk(this.config.root, 0);
        return found;
    }

    /** URL of the pre-bundled module for `spec`, registering it if it is new. */
    async urlFor(spec: string, resolved: string): Promise<string> {
        this.start();
        await this.initPromise;
        if (!this.deps.has(spec)) {
            this.deps.set(spec, resolved);
            this.schedule();
        }
        await this.ready();
        this.served = true;
        return `${this.depsUrl}/${flattenId(spec)}.js?v=${this.version}`;
    }

    private schedule(): void {
        this.dirty = true;
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.build();
        }, 30);
    }

    private async ready(): Promise<void> {
        while (this.dirty || this.building) {
            if (this.building) await this.building;
            else await new Promise((r) => setTimeout(r, 35));
        }
    }

    private async build(): Promise<void> {
        if (this.building) {
            await this.building;
            if (!this.dirty) return;
        }
        this.dirty = false;
        const wasServed = this.served;
        this.building = this.bundle().finally(() => {
            this.building = null;
        });
        await this.building;
        if (wasServed) {
            this.config.logger.info(`new dependencies optimized, reloading page`, { timestamp: true });
            this.onReload();
        }
    }

    private async bundle(): Promise<void> {
        const started = Date.now();
        const VIRTUAL = '\0lunx-dep:';
        const BUILTIN = '\0lunx-builtin:';
        const input: Record<string, string> = {};
        const virtual = new Map<string, string>();
        for (const [spec, file] of this.deps) {
            const name = flattenId(spec);
            const source = fs.readFileSync(file, 'utf-8');
            if (isEsm(file, source) || !/\b(module|exports|require)\b/.test(source)) {
                input[name] = spec;
                continue;
            }
            const id = VIRTUAL + name;
            virtual.set(id, [
                `import * as __m from ${JSON.stringify(spec)};`,
                'export default __m.default;',
                ...cjsExportNames(file, source, this.isClient ? undefined : this.requireResolver()).map((n) => `export const ${n} = __m.${n};`),
            ].join('\n'));
            input[name] = id;
        }
        const hash = crypto.createHash('sha256').update(JSON.stringify([...this.deps.keys()].sort())).update(String(started)).digest('hex').slice(0, 8);
        const tmpDir = `${this.depsDir}_temp_${hash}`;
        const resolve = this.config.environments[this.envName].resolve;
        const isClient = this.isClient;
        const builtins = new Set(builtinModules);
        await getBundler().bundle(
            {
                input,
                cwd: this.config.root,
                platform: isClient ? 'browser' : 'node',
                quiet: true,
                define: { 'process.env.NODE_ENV': JSON.stringify(this.config.isProduction ? 'production' : 'development'), global: 'globalThis' },
                conditions: [...resolve.conditions, 'import', 'default'],
                plugins: [{
                    name: 'lunx:optimize-deps',
                    resolveId(id: string) {
                        if (virtual.has(id)) return id;
                        const bare = id.replace(/^node:/, '');
                        if (builtins.has(bare) || builtins.has(bare.split('/')[0]!)) return isClient ? BUILTIN + bare : { id, external: true };
                        return null;
                    },
                    load(id: string) {
                        if (virtual.has(id)) return virtual.get(id)!;
                        if (!id.startsWith(BUILTIN)) return null;
                        // As Vite's optimizer: warn on use, never throw at import (dependencies often import
                        // server-only built-ins they never call in the browser).
                        const name = JSON.stringify(id.slice(BUILTIN.length));
                        return { code: `module.exports = Object.create(new Proxy({}, { get(_, k) { if (typeof k !== "symbol" && k !== "__esModule" && k !== "__proto__" && k !== "constructor" && k !== "then") console.warn("Module " + ${name} + " has been externalized for browser compatibility. Cannot access " + ${name} + "." + String(k) + " in client code."); } }));`, moduleType: 'js' };
                    },
                }],
            },
            { dir: tmpDir, format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunk-[hash].js', sourcemap: false },
            true,
        );
        fs.rmSync(this.depsDir, { recursive: true, force: true });
        fs.renameSync(tmpDir, this.depsDir);
        fs.writeFileSync(path.join(this.depsDir, 'package.json'), '{"type":"module"}');
        this.version = hash;
        this.config.logger.info(`pre-bundled ${this.deps.size} dependencies in ${Date.now() - started}ms`, { timestamp: true });
    }
}
