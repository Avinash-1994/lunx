/**
 * Build caches (`.lunx/`):
 *
 *  - Whole-build: a fingerprint of everything a build reads — every file in
 *    the project outside node_modules and the output (mtime + size), the
 *    package manager's install marker, the resolved config, the env vars
 *    that become defines, and lunx's version. When nothing changed and the
 *    output is untouched, `lunx build` reuses it instead of rebuilding.
 *  - Transform: framework compiler output (Vue / Svelte / Angular / JSX
 *    compiled in JS) keyed by source content and compiler settings, so a
 *    rebuild only recompiles the components that changed.
 *
 * `--force` or LUNX_BUILD_CACHE=0 skip them for one build; `build.cache: false`
 * in config stops recording builds, so the whole-build cache never hits.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.lunx', '.lunx_cache', '.cache', '.turbo', '.next', '.nuxt', '.svelte-kit', '.output', 'coverage']);
/** Above this many files the fingerprint costs more than it saves. */
const MAX_FILES = 25_000;
const INSTALL_MARKERS = ['node_modules/.package-lock.json', 'node_modules/.pnpm/lock.yaml', 'node_modules/.yarn-state.yml', 'node_modules/.modules.yaml'];

type Stamp = [number, number]; // mtimeMs, size

interface Entry {
    key: string;
    inputs: Record<string, Stamp>;
    outputs: Record<string, Stamp>;
    outDir: string;
    builtAt: number;
}

export function cacheEnabled(): boolean {
    return process.env.LUNX_BUILD_CACHE !== '0';
}

function stamp(file: string): Stamp | null {
    try {
        const s = fs.statSync(file);
        return [Math.round(s.mtimeMs), s.size];
    } catch {
        return null;
    }
}

/** Every file under `dir` (relative paths), skipping dependency, VCS, cache and output dirs. */
function walk(root: string, skip: Set<string>): Record<string, Stamp> | null {
    const out: Record<string, Stamp> = {};
    let count = 0;
    const visit = (dir: string): boolean => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return true;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name) || skip.has(full)) continue;
                if (!visit(full)) return false;
            } else if (e.isFile()) {
                if (++count > MAX_FILES) return false;
                const s = stamp(full);
                if (s) out[path.relative(root, full)] = s;
            }
        }
        return true;
    };
    return visit(root) ? out : null;
}

function serialize(value: unknown): string {
    const seen = new WeakSet();
    return JSON.stringify(value, (_k, v) => {
        if (typeof v === 'function') return `fn:${v.name}:${String(v).length}`;
        if (v instanceof RegExp) return `re:${v.source}/${v.flags}`;
        if (v && typeof v === 'object') {
            if (seen.has(v)) return '[circular]';
            seen.add(v);
        }
        return v;
    });
}

function lunxVersion(): string {
    try {
        return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    } catch {
        return 'unknown';
    }
}

function same(a: Record<string, Stamp>, b: Record<string, Stamp>): boolean {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const k of keys) {
        const x = a[k]!;
        const y = b[k];
        if (!y || x[0] !== y[0] || x[1] !== y[1]) return false;
    }
    return true;
}

interface Pending {
    file: string;
    key: string;
    outDir: string;
    inputs: Record<string, Stamp> | null;
}

/**
 * Before loading config: is the last build with these CLI options still
 * current? Config files are inputs like any other, so this needs no config,
 * and a hit skips loading it. Returns what `recordBuild` needs on a miss.
 */
export function checkBuild(root: string, options: Record<string, unknown>): { hit: boolean; outDir?: string; pending: Pending } {
    const env = Object.entries(process.env)
        .filter(([k]) => /^(NODE_ENV|LUNX_|VITE_|PUBLIC_|REACT_APP_)/.test(k) && k !== 'LUNX_TIMINGS')
        .sort(([a], [b]) => a.localeCompare(b));
    const key = crypto.createHash('sha256').update(lunxVersion()).update(serialize(options)).update(JSON.stringify(env)).digest('hex');
    const file = path.join(root, '.lunx', 'build-cache', `${crypto.createHash('sha256').update(serialize(options)).digest('hex').slice(0, 12)}.json`);
    let entry: Entry | null = null;
    try {
        entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        // no previous build
    }
    const outDir = entry?.outDir ?? path.join(root, 'dist');
    const inputs = inputsOf(root, outDir);
    const pending: Pending = { file, key, outDir, inputs };
    if (!entry || !inputs || entry.key !== key || !same(entry.inputs, inputs)) return { hit: false, pending };
    const outputs = walk(entry.outDir, new Set()) ?? {};
    const hit = Object.keys(entry.outputs).length > 0 && same(entry.outputs, outputs);
    return { hit, outDir: entry.outDir, pending };
}

function inputsOf(root: string, outDir: string): Record<string, Stamp> | null {
    const inputs = walk(root, new Set([outDir]));
    if (!inputs) return null;
    for (const marker of INSTALL_MARKERS) {
        const s = stamp(path.join(root, marker));
        if (s) inputs[marker] = s;
    }
    return inputs;
}

/** After a successful build: remember its inputs (as they were before it ran) and its output. */
export function recordBuild(root: string, pending: Pending, outDir: string, enabled = true): void {
    if (!enabled) {
        fs.rmSync(pending.file, { force: true });
        return;
    }
    // The first build learns the output directory from config; inputs are re-read without it.
    const inputs = outDir === pending.outDir ? pending.inputs : inputsOf(root, outDir);
    const outputs = walk(outDir, new Set());
    if (!inputs || !outputs) return;
    fs.mkdirSync(path.dirname(pending.file), { recursive: true });
    const entry: Entry = { key: pending.key, inputs, outputs, outDir, builtAt: Date.now() };
    fs.writeFileSync(pending.file, JSON.stringify(entry));
}

// ── Transform cache ──────────────────────────────────────────────────────────

/**
 * A disk cache for compiler output. `key` must cover everything the output
 * depends on (source, compiler and its options); entries are content-addressed,
 * so stale ones are never read, only left for `lunx clean`-style removal.
 */
export class TransformCache {
    private readonly dir: string;
    private readonly salt: string;

    constructor(root: string, scope: string, salt: string) {
        this.dir = path.join(root, '.lunx', 'transform-cache', scope);
        this.salt = `${lunxVersion()}\0${salt}`;
    }

    private file(parts: string[]): string {
        const h = crypto.createHash('sha256').update(this.salt);
        for (const p of parts) h.update('\0').update(p);
        const key = h.digest('hex');
        return path.join(this.dir, key.slice(0, 2), `${key.slice(2)}.json`);
    }

    async get(parts: string[]): Promise<any | null> {
        try {
            return JSON.parse(await fsp.readFile(this.file(parts), 'utf8'));
        } catch {
            return null;
        }
    }

    async set(parts: string[], value: unknown): Promise<void> {
        const file = this.file(parts);
        try {
            await fsp.mkdir(path.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            await fsp.writeFile(tmp, JSON.stringify(value));
            await fsp.rename(tmp, file);
        } catch {
            // A cache that cannot be written is a slower build, not a failed one.
        }
    }
}
