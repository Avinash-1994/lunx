/**
 * Zero-dependency persistence, replacing `better-sqlite3`.
 *
 * better-sqlite3 is a native addon: it needs a prebuilt binary or a working
 * node-gyp toolchain, which is the single most common install failure for a
 * build tool. Nothing in Lunx needed SQL -- the usages were a content cache
 * and two small record collections -- so both are implemented directly.
 *
 *   CacheStore   hash -> blob, content-addressed on disk, O(1) and crash-safe.
 *   RecordStore  a small collection of JSON records with field queries.
 *
 * Both APIs are synchronous, matching the call sites they replace.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ── Content-addressed cache ─────────────────────────────────────────────────

export interface CacheEntry<T> {
    value: T;
    timestamp: number;
}

export interface CacheStoreOptions {
    /** Drop entries older than this many ms on load. Default: 30 days. */
    maxAgeMs?: number;
    /** Compact when the cache exceeds this many entries. Default: 50_000. */
    maxEntries?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Keys are hashes, so entries are immutable and a write can never conflict
 * with a concurrent read of the same key. Values live in shard directories to
 * keep any one directory small on Windows.
 */
export class CacheStore<T = unknown> {
    private readonly dir: string;
    private readonly maxAgeMs: number;
    private readonly maxEntries: number;
    /** Keys known to exist, so a miss costs no syscall. */
    private readonly index = new Map<string, number>();
    private loaded = false;

    constructor(dir: string, options: CacheStoreOptions = {}) {
        this.dir = dir;
        this.maxAgeMs = options.maxAgeMs ?? 30 * DAY_MS;
        this.maxEntries = options.maxEntries ?? 50_000;
    }

    private shardPath(key: string): string {
        // First two hex chars as the shard: 256 directories at most.
        const shard = key.slice(0, 2).padEnd(2, '0');
        return path.join(this.dir, shard, `${key}.json`);
    }

    private ensureLoaded(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            for (const shard of fs.readdirSync(this.dir, { withFileTypes: true })) {
                if (!shard.isDirectory()) continue;
                const shardDir = path.join(this.dir, shard.name);
                for (const entry of fs.readdirSync(shardDir)) {
                    if (!entry.endsWith('.json')) continue;
                    const key = entry.slice(0, -5);
                    let mtime: number;
                    try {
                        mtime = fs.statSync(path.join(shardDir, entry)).mtimeMs;
                    } catch {
                        continue;
                    }
                    if (Date.now() - mtime > this.maxAgeMs) {
                        try {
                            fs.rmSync(path.join(shardDir, entry), { force: true });
                        } catch {
                            /* another process may have removed it already */
                        }
                        continue;
                    }
                    this.index.set(key, mtime);
                }
            }
        } catch {
            // An unreadable cache directory must never break a build.
        }
        if (this.index.size > this.maxEntries) this.prune();
    }

    has(key: string): boolean {
        this.ensureLoaded();
        return this.index.has(key);
    }

    get(key: string): T | null {
        this.ensureLoaded();
        if (!this.index.has(key)) return null;
        try {
            const raw = fs.readFileSync(this.shardPath(key), 'utf8');
            return (JSON.parse(raw) as CacheEntry<T>).value;
        } catch {
            // Truncated or corrupt entry: treat as a miss and forget it.
            this.index.delete(key);
            return null;
        }
    }

    set(key: string, value: T): void {
        this.ensureLoaded();
        const file = this.shardPath(key);
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            // Write to a temp file and rename, so a crash cannot leave a half-written entry.
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ value, timestamp: Date.now() } satisfies CacheEntry<T>));
            fs.renameSync(tmp, file);
            this.index.set(key, Date.now());
        } catch {
            // A cache write failure is not a build failure.
            return;
        }
        if (this.index.size > this.maxEntries) this.prune();
    }

    delete(key: string): void {
        this.ensureLoaded();
        this.index.delete(key);
        try {
            fs.rmSync(this.shardPath(key), { force: true });
        } catch {
            /* already gone */
        }
    }

    clear(): void {
        this.index.clear();
        this.loaded = true;
        try {
            fs.rmSync(this.dir, { recursive: true, force: true });
            fs.mkdirSync(this.dir, { recursive: true });
        } catch {
            /* nothing to clear */
        }
    }

    get size(): number {
        this.ensureLoaded();
        return this.index.size;
    }

    /** Evicts the oldest quarter once the entry ceiling is passed. */
    private prune(): void {
        const entries = [...this.index.entries()].sort((a, b) => a[1] - b[1]);
        const dropCount = Math.max(1, Math.floor(entries.length / 4));
        for (const [key] of entries.slice(0, dropCount)) this.delete(key);
    }
}

/** Convenience: the fingerprint helper the cache call sites all reimplemented. */
export function fingerprint(...parts: (string | number | undefined)[]): string {
    const hash = createHash('sha256');
    for (const part of parts) hash.update(String(part ?? ''), 'utf8');
    return hash.digest('hex');
}

// ── Record collection ───────────────────────────────────────────────────────

/** The one field a record must have: a stable primary key. */
export interface RecordLike {
    id: string;
}

/**
 * A small JSON-backed collection. Everything is held in memory and the whole
 * file is rewritten on change, which is the right trade for the hundreds of
 * rows these stores hold and removes SQL from the dependency tree.
 */
export class RecordStore<T extends RecordLike> {
    private readonly file: string;
    /** `:memory:` keeps everything in RAM, matching the SQLite convention. */
    private readonly inMemory: boolean;
    private rows = new Map<string, T>();
    private loaded = false;
    /** Set while a batch is open, so N inserts cost one write. */
    private deferWrites = false;
    private dirty = false;

    constructor(file: string) {
        this.file = file;
        this.inMemory = file === ':memory:';
    }

    private ensureLoaded(): void {
        if (this.loaded) return;
        this.loaded = true;
        if (this.inMemory) return;
        try {
            const raw = fs.readFileSync(this.file, 'utf8');
            const parsed = JSON.parse(raw) as T[];
            if (Array.isArray(parsed)) {
                for (const row of parsed) if (row && typeof row.id === 'string') this.rows.set(row.id, row);
            }
        } catch {
            // Missing or corrupt file: start empty rather than crash.
        }
    }

    private flush(): void {
        if (this.inMemory) return;
        if (this.deferWrites) {
            this.dirty = true;
            return;
        }
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify([...this.rows.values()], null, 0));
            fs.renameSync(tmp, this.file);
        } catch {
            /* best effort; the caller already has the in-memory state */
        }
    }

    /** Groups several mutations into a single write. */
    transaction<R>(fn: () => R): R {
        const wasDeferring = this.deferWrites;
        this.deferWrites = true;
        try {
            return fn();
        } finally {
            this.deferWrites = wasDeferring;
            if (!this.deferWrites && this.dirty) {
                this.dirty = false;
                this.flush();
            }
        }
    }

    put(row: T): T {
        this.ensureLoaded();
        this.rows.set(row.id, row);
        this.flush();
        return row;
    }

    get(id: string): T | null {
        this.ensureLoaded();
        return this.rows.get(id) ?? null;
    }

    has(id: string): boolean {
        this.ensureLoaded();
        return this.rows.has(id);
    }

    delete(id: string): boolean {
        this.ensureLoaded();
        const existed = this.rows.delete(id);
        if (existed) this.flush();
        return existed;
    }

    /** Deletes every row matching the predicate; returns how many went. */
    deleteWhere(predicate: (row: T) => boolean): number {
        this.ensureLoaded();
        let count = 0;
        for (const [id, row] of this.rows) {
            if (predicate(row)) {
                this.rows.delete(id);
                count++;
            }
        }
        if (count > 0) this.flush();
        return count;
    }

    all(): T[] {
        this.ensureLoaded();
        return [...this.rows.values()];
    }

    find(predicate: (row: T) => boolean): T[] {
        return this.all().filter(predicate);
    }

    findOne(predicate: (row: T) => boolean): T | null {
        this.ensureLoaded();
        for (const row of this.rows.values()) if (predicate(row)) return row;
        return null;
    }

    count(predicate?: (row: T) => boolean): number {
        this.ensureLoaded();
        if (!predicate) return this.rows.size;
        let n = 0;
        for (const row of this.rows.values()) if (predicate(row)) n++;
        return n;
    }

    sum(field: keyof T): number {
        this.ensureLoaded();
        let total = 0;
        for (const row of this.rows.values()) {
            const value = (row as Record<string, unknown>)[field as string];
            if (typeof value === 'number' && Number.isFinite(value)) total += value;
        }
        return total;
    }

    /** Sorted read, newest-first by default when the rows carry a timestamp. */
    list(options: { sortBy?: keyof T; desc?: boolean; limit?: number; offset?: number } = {}): T[] {
        const { sortBy, desc = true, limit, offset = 0 } = options;
        let rows = this.all();
        if (sortBy) {
            rows = rows.sort((a, b) => {
                const av = a[sortBy];
                const bv = b[sortBy];
                if (av === bv) return 0;
                const less = (av as any) < (bv as any);
                return (less ? -1 : 1) * (desc ? -1 : 1);
            });
        }
        return limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit);
    }

    clear(): void {
        this.loaded = true;
        this.rows.clear();
        this.flush();
    }
}

export default { CacheStore, RecordStore, fingerprint };
