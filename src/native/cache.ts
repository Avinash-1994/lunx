import native from './index.js';

const NativeBuildCache = native.BuildCache;

export interface CacheStats {
    totalEntries: number;
    hits: number;
    misses: number;
    hitRate: number;
    sizeBytes: number;
}

type NativeBuildCacheType = {
    get(key: string): string | null | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    has(key: string): boolean;
    batchSet(entries: Record<string, string>): void;
    clearTarget(target: string): number;
    clearAll(): void;
    getStats(): CacheStats;
    compact(): void;
    close(): void;
};

/**
 * Persistent build cache (Rust SQLite when native is loaded; in-memory JS fallback).
 */
export class BuildCache {
    private cache: NativeBuildCacheType;

    constructor(cachePath: string) {
        this.cache = new NativeBuildCache(cachePath);
    }

    get(key: string): string | null {
        return this.cache.get(key) || null;
    }

    set(key: string, value: string): void {
        this.cache.set(key, value);
    }

    delete(key: string): void {
        this.cache.delete(key);
    }

    has(key: string): boolean {
        return this.cache.has(key);
    }

    batchSet(entries: Record<string, string>): void {
        this.cache.batchSet(entries);
    }

    clearTarget(target: 'dev' | 'prod' | 'lib'): number {
        return this.cache.clearTarget(target);
    }

    clearAll(): void {
        this.cache.clearAll();
    }

    getStats(): CacheStats {
        return this.cache.getStats();
    }

    compact(): void {
        this.cache.compact();
    }

    close(): void {
        this.cache.close();
    }
}

export function createInputKey(filePath: string, contentHash: string): string {
    return native.createInputKey ? native.createInputKey(filePath, contentHash) : `input:${filePath}:${contentHash}`;
}

export function createGraphKey(graphHash: string): string {
    return native.createGraphKey ? native.createGraphKey(graphHash) : `graph:${graphHash}`;
}

export function createPlanKey(planHash: string, target: string): string {
    return native.createPlanKey ? native.createPlanKey(planHash, target) : `plan:${target}:${planHash}`;
}

export function createArtifactKey(artifactId: string, target: string): string {
    return native.createArtifactKey ? native.createArtifactKey(artifactId, target) : `artifact:${target}:${artifactId}`;
}
