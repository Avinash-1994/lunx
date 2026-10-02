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
import { arraify, normalizePath } from './utils.js';
import { getPackageName } from './plugins/resolve.js';

const require = createRequire(import.meta.url);
const RESERVED = new Set(['default', '__esModule', 'arguments', 'eval', 'await', 'yield', 'let', 'static', 'enum', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with']);
const SCAN_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.svelte-kit', '.react-router', '.nuxt', '.output', '.vite', 'coverage']);
const SOURCE_RE = /\.(m?[jt]sx?|vue|svelte|astro)$/;

function isEsm(file: string, source: string): boolean {
    if (/\.mjs$/.test(file)) return true;
    if (/\.cjs$/.test(file)) return false;
    try {
        return parse(file, source, 'js').body.some((n: any) => /^(Import|Export)/.test(n.type));
    } catch {
        return false;
    }
}

function cjsExportNames(file: string, source: string): string[] {
    let keys: string[] = [];
    try {
        const mod = require(file);
        if (mod && (typeof mod === 'object' || typeof mod === 'function')) keys = Object.keys(mod);
    } catch {
        for (const m of source.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=|Object\.defineProperty\(\s*(?:module\.)?exports\s*,\s*['"]([A-Za-z_$][\w$]*)['"]/g)) keys.push((m[1] ?? m[2])!);
    }
    return [...new Set(keys)].filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && !RESERVED.has(k));
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

    constructor(private config: any, private resolve: (spec: string) => string | null, private onReload: () => void) {
        this.depsDir = path.join(config.cacheDir, 'deps');
        const rel = path.relative(config.root, this.depsDir);
        this.depsUrl = rel.startsWith('..') ? `/@fs/${normalizePath(this.depsDir).replace(/^\//, '')}` : '/' + normalizePath(rel);
    }

    private exclude(spec: string): boolean {
        const pkg = getPackageName(spec);
        return arraify(this.config.optimizeDeps?.exclude ?? []).some((e: string) => e === pkg || e === spec || spec.startsWith(e + '/'));
    }

    /** Should this bare import be served pre-bundled? */
    shouldOptimize(spec: string, resolved: string): boolean {
        if (this.config.optimizeDeps?.noDiscovery && !this.deps.has(spec)) return false;
        if (!/[\\/]node_modules[\\/]/.test(resolved) || !/\.(m|c)?jsx?$/.test(resolved)) return false;
        return !this.exclude(spec);
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
        for (const spec of arraify(this.config.optimizeDeps?.include ?? [])) this.add(spec);
        for (const spec of this.scan()) this.add(spec);
        if (this.deps.size) await this.build();
    }

    private add(spec: string): boolean {
        if (this.deps.has(spec) || builtinModules.includes(spec) || spec.startsWith('node:')) return false;
        const resolved = this.resolve(spec);
        if (!resolved || !this.shouldOptimize(spec, resolved)) return false;
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
                } else if (SOURCE_RE.test(entry.name)) {
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
                ...cjsExportNames(file, source).map((n) => `export const ${n} = __m.${n};`),
            ].join('\n'));
            input[name] = id;
        }
        const hash = crypto.createHash('sha256').update(JSON.stringify([...this.deps.keys()].sort())).update(String(started)).digest('hex').slice(0, 8);
        const tmpDir = `${this.depsDir}_temp_${hash}`;
        const resolve = this.config.environments.client.resolve;
        const builtins = new Set(builtinModules);
        await getBundler().bundle(
            {
                input,
                cwd: this.config.root,
                platform: 'browser',
                quiet: true,
                define: { 'process.env.NODE_ENV': JSON.stringify(this.config.isProduction ? 'production' : 'development'), global: 'globalThis' },
                conditions: [...resolve.conditions, 'import', 'default'],
                plugins: [{
                    name: 'lunx:optimize-deps',
                    resolveId(id: string) {
                        if (virtual.has(id)) return id;
                        const bare = id.replace(/^node:/, '');
                        if (builtins.has(bare) || builtins.has(bare.split('/')[0]!)) return BUILTIN + bare;
                        return null;
                    },
                    load(id: string) {
                        if (virtual.has(id)) return virtual.get(id)!;
                        if (!id.startsWith(BUILTIN)) return null;
                        return { code: 'module.exports = new Proxy({}, { get(_, k) { if (typeof k === "symbol" || k === "__esModule" || k === "then") return undefined; throw new Error("Node built-in module used in browser code (" + String(k) + ")"); } });', moduleType: 'js' };
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
