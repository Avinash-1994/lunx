/**
 * Zero-dependency filesystem watcher.
 *
 * Replaces `chokidar` (and its readdirp / picomatch / braces / anymatch tree)
 * with `fs.watch`. Node >= 20 supports `recursive: true` on Windows, macOS and
 * Linux; when a platform or filesystem rejects it we fall back to walking the
 * tree and watching each directory ourselves.
 *
 * The emitted event names match chokidar's (`add`, `change`, `unlink`,
 * `addDir`, `unlinkDir`, plus the `all` firehose) so call sites are unchanged.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type WatchEvent = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface WatchOptions {
    /** Do not emit `add`/`addDir` for files that already exist. Default true. */
    ignoreInitial?: boolean;
    /** Keep the process alive while watching. Default true. */
    persistent?: boolean;
    /** Globs, regexes, absolute paths or a predicate. */
    ignored?: Ignored;
    /** Coalescing window in ms for rapid successive writes. Default 20. */
    debounce?: number;
    /** Maximum directory depth to descend. Default Infinity. */
    depth?: number;
    /** Root that relative `ignored` globs resolve against. Default cwd. */
    cwd?: string;
}

type IgnoredAtom = string | RegExp | ((testPath: string) => boolean);
export type Ignored = IgnoredAtom | IgnoredAtom[] | undefined;

/** Directories never worth descending into; skipping them is most of the speed win. */
const ALWAYS_IGNORED = new Set(['.git', 'node_modules', '.lunx', 'dist', '.cache', '.next', '.nuxt', '.svelte-kit']);

/**
 * Compiles a glob to a RegExp. Supports the subset chokidar users actually
 * write for `ignored`: `*`, `**`, `?`, `{a,b}` and character classes.
 */
export function globToRegExp(glob: string): RegExp {
    let out = '';
    let i = 0;
    while (i < glob.length) {
        const ch = glob[i]!;
        if (ch === '*') {
            const isGlobstar = glob[i + 1] === '*';
            if (isGlobstar) {
                const followedBySlash = glob[i + 2] === '/';
                out += followedBySlash ? '(?:.*/)?' : '.*';
                i += followedBySlash ? 3 : 2;
                continue;
            }
            out += '[^/]*';
            i++;
            continue;
        }
        if (ch === '?') {
            out += '[^/]';
            i++;
            continue;
        }
        if (ch === '{') {
            const end = glob.indexOf('}', i);
            if (end !== -1) {
                const alts = glob.slice(i + 1, end).split(',');
                out += `(?:${alts.map((a) => a.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`;
                i = end + 1;
                continue;
            }
        }
        if (ch === '[') {
            const end = glob.indexOf(']', i);
            if (end !== -1) {
                out += glob.slice(i, end + 1);
                i = end + 1;
                continue;
            }
        }
        out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        i++;
    }
    return new RegExp(`^${out}$`);
}

function compileIgnored(ignored: Ignored): (testPath: string) => boolean {
    const atoms = ignored === undefined ? [] : Array.isArray(ignored) ? ignored : [ignored];
    const predicates = atoms.map((atom): ((p: string) => boolean) => {
        if (typeof atom === 'function') return atom;
        if (atom instanceof RegExp) return (p) => atom.test(p);
        const re = globToRegExp(atom);
        return (p) => re.test(p) || p.includes(atom);
    });
    if (predicates.length === 0) return () => false;
    return (testPath) => {
        const normalized = testPath.split(path.sep).join('/');
        return predicates.some((fn) => fn(normalized) || fn(testPath));
    };
}

interface Entry {
    mtimeMs: number;
    size: number;
    isDir: boolean;
}

export class FSWatcher extends EventEmitter {
    private readonly options: Required<Pick<WatchOptions, 'ignoreInitial' | 'persistent' | 'debounce' | 'depth'>>;
    private readonly isIgnored: (p: string) => boolean;
    private readonly watchers = new Map<string, fs.FSWatcher>();
    /** Known state of every file we have seen, for classifying add vs change vs unlink. */
    private readonly known = new Map<string, Entry>();
    private readonly pending = new Map<string, NodeJS.Timeout>();
    private readonly roots: string[];
    private closed = false;
    private ready = false;
    /** Directory roots covered by one native recursive watcher. */
    private recursiveRoots = new Set<string>();

    constructor(paths: string | string[], options: WatchOptions = {}) {
        super();
        this.roots = (Array.isArray(paths) ? paths : [paths]).map((p) => path.resolve(options.cwd ?? process.cwd(), p));
        this.options = {
            ignoreInitial: options.ignoreInitial ?? true,
            persistent: options.persistent ?? true,
            debounce: options.debounce ?? 20,
            depth: options.depth ?? Infinity,
        };
        this.isIgnored = compileIgnored(options.ignored);
        void this.start();
    }

    private async start(): Promise<void> {
        try {
            for (const root of this.roots) await this.addRoot(root);
            this.ready = true;
            this.emit('ready');
        } catch (err) {
            this.emit('error', err as Error);
        }
    }

    private async addRoot(root: string): Promise<void> {
        let stat: fs.Stats;
        try {
            stat = await fsp.stat(root);
        } catch {
            // A watched config file may not exist yet; watch its directory instead.
            const dir = path.dirname(root);
            if (dir !== root) await this.watchDirectory(dir);
            return;
        }

        if (stat.isFile()) {
            this.known.set(root, { mtimeMs: stat.mtimeMs, size: stat.size, isDir: false });
            await this.watchDirectory(path.dirname(root));
            return;
        }

        await this.watchDirectory(root, true);
        await this.scan(root, 0);
    }

    /** Seeds `known` so later events can be classified, and emits initial adds if asked. */
    private async scan(dir: string, depth: number): Promise<void> {
        if (depth > this.options.depth) return;
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (ALWAYS_IGNORED.has(entry.name) || this.isIgnored(full)) continue;
            if (entry.isDirectory()) {
                this.known.set(full, { mtimeMs: 0, size: 0, isDir: true });
                if (!this.options.ignoreInitial) this.fire('addDir', full);
                // Without recursive support we need a watcher on every directory.
                await this.watchDirectory(full);
                await this.scan(full, depth + 1);
            } else if (entry.isFile()) {
                try {
                    const st = await fsp.stat(full);
                    this.known.set(full, { mtimeMs: st.mtimeMs, size: st.size, isDir: false });
                } catch {
                    continue;
                }
                if (!this.options.ignoreInitial) this.fire('add', full);
            }
        }
    }

    private coveredByRecursive(dir: string): boolean {
        for (const root of this.recursiveRoots) if (dir === root || dir.startsWith(root + path.sep)) return true;
        return false;
    }

    private async watchDirectory(dir: string, allowRecursive = false): Promise<void> {
        if (this.closed || this.watchers.has(dir) || this.coveredByRecursive(dir)) return;

        const handler = (_event: string, filename: string | Buffer | null) => {
            if (!filename) return;
            const name = typeof filename === 'string' ? filename : filename.toString('utf8');
            this.queue(path.resolve(dir, name));
        };

        // One native recursive watcher where the OS provides it (FSEvents,
        // ReadDirectoryChangesW). Not on Linux: Node implements recursion
        // there in JS, walking and stat-ing the whole tree -- node_modules
        // included, `ignored` not consulted -- which made startup scale with
        // the size of node_modules. Per-directory watchers honour `ignored`.
        if (allowRecursive && process.platform !== 'linux') {
            try {
                const w = fs.watch(dir, { persistent: this.options.persistent, recursive: true }, handler);
                w.on('error', (err) => this.emit('error', err));
                this.watchers.set(dir, w);
                this.recursiveRoots.add(dir);
                return;
            } catch {
                /* fall through to a per-directory watcher */
            }
        }

        try {
            const w = fs.watch(dir, { persistent: this.options.persistent }, handler);
            w.on('error', (err) => this.emit('error', err));
            this.watchers.set(dir, w);
        } catch (err) {
            // The directory went away between readdir and watch (a build emptying its output): not an error.
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
            this.emit('error', err as Error);
        }
    }

    /**
     * fs.watch fires several times for one logical write (truncate, then data,
     * then metadata), so coalesce per path before classifying.
     */
    private queue(fullPath: string): void {
        if (this.closed) return;
        const base = path.basename(fullPath);
        if (ALWAYS_IGNORED.has(base) || this.isIgnored(fullPath)) return;
        // Ignore anything under an always-ignored directory.
        if (fullPath.split(path.sep).some((seg) => ALWAYS_IGNORED.has(seg))) return;

        const existing = this.pending.get(fullPath);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.pending.delete(fullPath);
            void this.classify(fullPath);
        }, this.options.debounce);
        timer.unref?.();
        this.pending.set(fullPath, timer);
    }

    private async classify(fullPath: string): Promise<void> {
        if (this.closed) return;
        const previous = this.known.get(fullPath);
        let stat: fs.Stats | null = null;
        try {
            stat = await fsp.stat(fullPath);
        } catch {
            stat = null;
        }

        if (!stat) {
            if (!previous) return;
            this.known.delete(fullPath);
            if (previous.isDir) {
                this.watchers.get(fullPath)?.close();
                this.watchers.delete(fullPath);
                this.fire('unlinkDir', fullPath);
            } else {
                this.fire('unlink', fullPath);
            }
            return;
        }

        if (stat.isDirectory()) {
            if (previous) return;
            this.known.set(fullPath, { mtimeMs: 0, size: 0, isDir: true });
            await this.watchDirectory(fullPath);
            this.fire('addDir', fullPath);
            // A directory can appear with children already inside it (git checkout, mv).
            await this.scan(fullPath, 0);
            return;
        }

        const next: Entry = { mtimeMs: stat.mtimeMs, size: stat.size, isDir: false };
        if (!previous) {
            this.known.set(fullPath, next);
            if (this.ready || !this.options.ignoreInitial) this.fire('add', fullPath);
            return;
        }
        // Editors touch files without changing them; only report real writes.
        if (previous.mtimeMs === next.mtimeMs && previous.size === next.size) return;
        this.known.set(fullPath, next);
        this.fire('change', fullPath);
    }

    private fire(event: WatchEvent, fullPath: string): void {
        this.emit(event, fullPath);
        this.emit('all', event, fullPath);
    }

    /** Adds more paths to an existing watcher, like chokidar's `add`. */
    async add(paths: string | string[]): Promise<void> {
        for (const p of Array.isArray(paths) ? paths : [paths]) {
            await this.addRoot(path.resolve(p));
        }
    }

    getWatched(): Record<string, string[]> {
        const out: Record<string, string[]> = {};
        for (const [p, entry] of this.known) {
            if (entry.isDir) continue;
            const dir = path.dirname(p);
            (out[dir] ??= []).push(path.basename(p));
        }
        return out;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const timer of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
        for (const w of this.watchers.values()) w.close();
        this.watchers.clear();
        this.known.clear();
        this.removeAllListeners();
    }
}

/** chokidar-compatible entry point. */
export function watch(paths: string | string[], options: WatchOptions = {}): FSWatcher {
    return new FSWatcher(paths, options);
}

export default { watch, FSWatcher };
