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
    /** First build: the inputs, read in the background while it runs (output directory not yet known). */
    scan?: Promise<Record<string, Stamp> | null>;
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
    if (!entry) {
        // Nothing to compare against: read the inputs while the build runs (Rolldown bundles in
        // Rust threads, so the main thread is mostly waiting) instead of before it starts.
        const scan = inputsOfAsync(root);
        scan.catch(() => {});
        return { hit: false, pending: { file, key, outDir: '', inputs: null, scan } };
    }
    const outDir = entry.outDir;
    const inputs = inputsOf(root, outDir);
    const pending: Pending = { file, key, outDir, inputs };
    if (!inputs || entry.key !== key || !same(entry.inputs, inputs)) return { hit: false, pending };
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

async function inputsOfAsync(root: string): Promise<Record<string, Stamp> | null> {
    const inputs = await walkAsync(root);
    if (!inputs) return null;
    for (const marker of INSTALL_MARKERS) {
        const s = stamp(path.join(root, marker));
        if (s) inputs[marker] = s;
    }
    return inputs;
}

/** `walk`, without blocking the event loop. */
async function walkAsync(root: string): Promise<Record<string, Stamp> | null> {
    const out: Record<string, Stamp> = {};
    let count = 0;
    let overflow = false;
    const visit = async (dir: string): Promise<void> => {
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        await Promise.all(entries.map(async (e) => {
            if (overflow) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name)) await visit(full);
            } else if (e.isFile()) {
                if (++count > MAX_FILES) {
                    overflow = true;
                    return;
                }
                try {
                    const st = await fsp.stat(full);
                    out[path.relative(root, full)] = [Math.round(st.mtimeMs), st.size];
                } catch {
                    // removed meanwhile
                }
            }
        }));
    };
    await visit(root);
    return overflow ? null : out;
}

/** After a successful build: remember its inputs (as they were before it ran) and its output. */
export async function recordBuild(root: string, pending: Pending, outDir: string, enabled = true): Promise<void> {
    if (!enabled) {
        fs.rmSync(pending.file, { force: true });
        return;
    }
    let inputs: Record<string, Stamp> | null;
    if (pending.scan) {
        // Read before the output directory was known: drop what the build wrote there.
        inputs = await pending.scan;
        const prefix = path.relative(root, outDir);
        if (inputs && prefix && !prefix.startsWith('..')) {
            for (const k of Object.keys(inputs)) if (k === prefix || k.startsWith(prefix + path.sep)) delete inputs[k];
        }
    } else {
        // The output directory moved since the last build: inputs are re-read without it.
        inputs = outDir === pending.outDir ? pending.inputs : inputsOf(root, outDir);
    }
    const outputs = walk(outDir, new Set());
    if (!inputs || !outputs) return;
    fs.mkdirSync(path.dirname(pending.file), { recursive: true });
    const entry: Entry = { key: pending.key, inputs, outputs, outDir, builtAt: Date.now() };
    fs.writeFileSync(pending.file, JSON.stringify(entry));
}

// ── Transform cache ──────────────────────────────────────────────────────────

/**
 * A disk cache for compiler output. Each entry is keyed by everything the
 * output depends on (source, compiler and its options), so a stale entry is
 * never read.
 *
 * Entries live in one pack file per scope, read once when first needed and
 * written once by `flush()`: a thousand small files cost more in syscalls
 * than the compiling they save. The written pack holds only the entries this
 * build used, so entries for deleted or edited files drop out on their own.
 */
export class TransformCache {
    private readonly file: string;
    private readonly salt: string;
    private entries: Map<string, unknown> | null = null;
    private loading: Promise<Map<string, unknown>> | null = null;
    private readonly used = new Map<string, unknown>();
    private dirty = false;

    constructor(root: string, scope: string, salt: string) {
        this.file = path.join(root, '.lunx', 'transform-cache', `${scope}.json`);
        this.salt = `${lunxVersion()}\0${salt}`;
    }

    private key(parts: string[]): string {
        const h = crypto.createHash('sha256').update(this.salt);
        for (const p of parts) h.update('\0').update(p);
        return h.digest('base64url');
    }

    private load(): Promise<Map<string, unknown>> {
        if (this.entries) return Promise.resolve(this.entries);
        return (this.loading ??= fsp
            .readFile(this.file, 'utf8')
            .then((text) => new Map(Object.entries(JSON.parse(text))))
            .catch(() => new Map<string, unknown>())
            .then((m) => (this.entries = m)));
    }

    async get(parts: string[]): Promise<any | null> {
        const key = this.key(parts);
        const entries = await this.load();
        if (!entries.has(key)) return null;
        const value = entries.get(key);
        this.used.set(key, value);
        return value;
    }

    async set(parts: string[], value: unknown): Promise<void> {
        this.used.set(this.key(parts), value);
        this.dirty = true;
    }

    /** Write the entries this build used. A cache that cannot be written is a slower next build, not a failure. */
    async flush(): Promise<void> {
        const entries = await this.load();
        if (!this.dirty && this.used.size === entries.size) return;
        try {
            await fsp.mkdir(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(this.used)));
            await fsp.rename(tmp, this.file);
        } catch {
            // ignore
        }
    }
}
