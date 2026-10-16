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
import { remoteCache } from './remote-cache.js';
import type { Stamp, Entry } from './stamps.cjs';
// A default import: CommonJS named exports are not detected in every loader (tsx's output among them).
import stamps from './stamps.cjs';

const { SKIP_DIRS, walk, inputsOf, addInstallMarkers, same, buildEnv, snapshotOutput, outputCurrent, invocation, lastBuildFile } = stamps;

const MAX_FILES = 25_000;

export function cacheEnabled(): boolean {
    return process.env.LUNX_BUILD_CACHE !== '0';
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

interface Pending {
    file: string;
    key: string;
    outDir: string;
    inputs: Record<string, Stamp> | null;
    /** First build: the inputs, read while it runs (output directory not yet known). */
    scan?: () => Promise<Record<string, Stamp> | null>;
}

/** First builds' input scans not started yet: they start once Rolldown is busy (`startInputScans`). */
const waitingScans = new Set<() => unknown>();

/**
 * Start reading the first build's inputs. Called once Rolldown is rendering in
 * Rust and the main thread is idle: started earlier, thousands of stats hold
 * up the config load and every file read before the bundle.
 */
export function startInputScans(): void {
    for (const start of waitingScans) start();
    waitingScans.clear();
}

/**
 * Before loading config: is the last build with these CLI options still
 * current? Config files are inputs like any other, so this needs no config,
 * and a hit skips loading it. Returns what `recordBuild` needs on a miss.
 */
export function checkBuild(root: string, options: Record<string, unknown>): { hit: boolean; restored?: boolean; outDir?: string; pending: Pending } {
    const env = buildEnv();
    const key = crypto.createHash('sha256').update(lunxVersion()).update(serialize(options)).update(JSON.stringify(env)).digest('hex');
    const file = path.join(root, '.lunx', 'build-cache', `${crypto.createHash('sha256').update(serialize(options)).digest('hex').slice(0, 12)}.json`);
    let entry: Entry | null = null;
    try {
        entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        // no previous build
    }
    // Settled without the inputs (other options, or the output was removed or changed): it
    // rebuilds whatever they are, so read them while Rolldown renders (in Rust threads, the main
    // thread mostly waiting) instead of before the build starts.
    // Other options or a first build: it rebuilds whatever the inputs are, so read them while
    // Rolldown renders (in Rust threads, the main thread mostly waiting) instead of before.
    if (!entry || entry.key !== key) {
        let started: Promise<Record<string, Stamp> | null> | null = null;
        const scan = () => (started ??= inputsOfAsync(root).catch(() => null));
        waitingScans.add(scan);
        return { hit: false, pending: { file, key, outDir: '', inputs: null, scan } };
    }
    const outDir = entry.outDir;
    const inputs = inputsOf(root, outDir);
    // Unchanged inputs: the output stands, restored from its snapshot if it was removed or changed.
    const state = inputs && same(entry.inputs, inputs) ? outputCurrent(file, entry) : false;
    return { hit: !!state, restored: state === 'restored', outDir, pending: { file, key, outDir, inputs } };
}

async function inputsOfAsync(root: string): Promise<Record<string, Stamp> | null> {
    const inputs = await walkAsync(root);
    if (!inputs) return null;
    addInstallMarkers(root, inputs);
    return inputs;
}

/**
 * `walk` while Rolldown renders: synchronous stats (a few µs each; a promise
 * and a libuv round trip per file cost ~4× the CPU, which Rolldown's threads
 * need), yielding every few hundred files so its JS hooks are not held up.
 */
async function walkAsync(root: string): Promise<Record<string, Stamp> | null> {
    const out: Record<string, Stamp> = {};
    let count = 0;
    const dirs = [root];
    while (dirs.length) {
        const dir = dirs.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name)) dirs.push(full);
            } else if (e.isFile()) {
                if (++count > MAX_FILES) return null;
                const st = fs.statSync(full, { throwIfNoEntry: false });
                if (st) out[path.relative(root, full)] = [Math.round(st.mtimeMs), st.size];
                if (count % 256 === 0) await new Promise((resolve) => setImmediate(resolve));
            }
        }
    }
    return out;
}

/** After a successful build: remember its inputs (as they were before it ran) and its output. */
export async function recordBuild(root: string, pending: Pending, outDir: string, enabled = true, cliArgs?: string[]): Promise<void> {
    if (!enabled) {
        fs.rmSync(pending.file, { force: true });
        return;
    }
    let inputs: Record<string, Stamp> | null;
    if (pending.scan) {
        // Read before the output directory was known: drop what the build wrote there.
        waitingScans.delete(pending.scan);
        inputs = await pending.scan();
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
    snapshotOutput(pending.file, entry);
    // The CLI's fast path (cli-fast.cts) checks this invocation before loading lunx.
    if (cliArgs) fs.writeFileSync(lastBuildFile(root), JSON.stringify({ invocation: invocation(lunxVersion(), cliArgs), entry: pending.file }));
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

    /** The shared copy (`cache.remote`), keyed by scope and compiler versions. */
    private readonly remoteKey: string;

    constructor(root: string, scope: string, salt: string) {
        this.file = path.join(root, '.lunx', 'transform-cache', `${scope}.json`);
        this.salt = `${lunxVersion()}\0${salt}`;
        this.remoteKey = `transform-cache/${scope}.${crypto.createHash('sha256').update(this.salt).digest('hex').slice(0, 16)}.json`;
    }

    private key(parts: string[]): string {
        const h = crypto.createHash('sha256').update(this.salt);
        for (const p of parts) h.update('\0').update(p);
        return h.digest('base64url');
    }

    private load(): Promise<Map<string, unknown>> {
        if (this.entries) return Promise.resolve(this.entries);
        return (this.loading ??= Promise.all([
            fsp.readFile(this.file, 'utf8').then((text) => Object.entries(JSON.parse(text))).catch(() => []),
            remoteCache()?.get(this.remoteKey).then((b) => (b ? Object.entries(JSON.parse(b.toString('utf8'))) : [])).catch(() => []) ?? [],
        ]).then(([local, shared]) => (this.entries = new Map<string, unknown>([...shared, ...local]))));
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
            const text = JSON.stringify(Object.fromEntries(this.used));
            await fsp.writeFile(tmp, text);
            await fsp.rename(tmp, this.file);
            const shared = remoteCache();
            if (shared && !shared.readOnly && this.dirty) await shared.put(this.remoteKey, Buffer.from(text));
        } catch {
            // ignore
        }
    }
}
