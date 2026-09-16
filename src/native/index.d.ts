/**
 * Lunx v2.0 Native Module Definitions
 */

export interface CacheStats {
    totalEntries: number;
    hits: number;
    misses: number;
    hitRate: number;
    sizeBytes: number;
}

export interface BuildEvent {
    stage: string;
    message: string;
    timestamp: number;
    durationMs?: number;
    metadata?: string;
}

export interface OrchestratorStats {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    totalDurationMs: number;
    parallelism: number;
}

export class BuildCache {
    constructor(cachePath: string);
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    has(key: string): boolean;
    batchSet(entries: Record<string, string>): void;
    clearTarget(target: string): number;
    clearAll(): void;
    getStats(): CacheStats;
    compact(): void;
    close(): void;
}

export class BuildOrchestrator {
    constructor(parallelism?: number);
    logEvent(stage: string, message: string, durationMs?: number): Promise<void>;
    getEvents(): Promise<BuildEvent[]>;
    clearEvents(): Promise<void>;
    executeParallel(taskCount: number): Promise<OrchestratorStats>;
    processParallelSync(items: string[]): string[];
    generateStableId(content: string, prefix: string): string;
    batchGenerateIds(items: string[], prefix: string): string[];
    getStats(): Promise<OrchestratorStats>;
    readonly parallelism: number;
    shutdown(): void;
}


export interface CircularDependency {
    cycle: string[];
    entryPoint: string;
}

export interface GraphAnalysisResult {
    hasCycles: boolean;
    cycles: CircularDependency[];
    orphanedNodes: string[];
    entryPoints: string[];
    totalNodes: number;
    totalEdges: number;
}

export class GraphAnalyzer {
    constructor();
    addBatch(ids: string[], edges: string[][]): void;
    detectCycles(): CircularDependency[];
    findOrphanedNodes(entryPoints: string[]): string[];
    analyze(entryPoints: string[]): GraphAnalysisResult;
    topologicalSort(): string[] | null;
    nodeCount(): number;
    edgeCount(): number;
    clear(): void;
}

export interface TransformConfig {
    path: string;
    content: string;
    loader: string;
    minify?: boolean;
}

export interface TransformResult {
    code: string;
}

export class NativeWorker {
    constructor(poolSize?: number);
    /** Transform a single file using SWC (JS/TS) or LightningCSS (CSS). */
    transformSync(config: TransformConfig): TransformResult;
    transformSync(code: string, filePath?: string): string;
    /** Parallel transform across all CPU cores. */
    batchTransform(items: TransformConfig[]): Promise<TransformResult[]>;
    processFile(filePath: string): null;
}
export { NativeWorker as RustNativeWorker };

export function fastHash(content: string): string;
export function batchHash(contents: string[]): string[];
export function scanImports(code: string): string[];
export function normalizePath(path: string): string;
export function helloRust(): string;
export function minifySync(code: string): string;

export const engineUsed: 'native' | 'js';
export function getOptimalParallelism(): number;
export function benchmarkParallelism(itemCount: number): Record<string, number>;
export function createInputKey(filePath: string, contentHash: string): string;
export function createGraphKey(graphHash: string): string;
export function createPlanKey(planHash: string, target: string): string;
export function createArtifactKey(artifactId: string, target: string): string;

export class PluginRuntime {
    constructor();
    verifyPlugin(wasmBytes: Buffer): boolean;
    execute(wasmBytes: Buffer, input: string, timeoutMs: number): string;
}

/**
 * Phase 2.2 — LightningCSS hoisted as top-level N-API export.
 * Transforms CSS source using LightningCSS directly (not via transform() combined call).
 */
export function transformCss(code: string, filename: string, minify: boolean): string;

/**
 * Phase 2.2 — SWC hoisted as top-level N-API export.
 * Transforms JS/TS source using SWC directly (not via transform() combined call).
 */
export function transformJs(code: string, filename: string, minify: boolean): string;

// ─── Phase 3 — Additive Exports ───────────────────────────────────────────────

export interface ChunkerConfig {
    /** "auto" | "manual" */
    strategy: string;
    /** Max chunk size in KB (0 = unlimited) */
    maxChunkSizeKb: number;
    /** Entry point module IDs */
    entryPoints: string[];
}

export interface ChunkOutput {
    hash: string;
    modules: string[];
    isEntry: boolean;
    sizeBytes: number;
}

export interface ChunkerResult {
    chunks: ChunkOutput[];
    /** Module IDs eliminated by DCE */
    eliminated: string[];
    totalModules: number;
    liveModules: number;
}

/** Phase 3.1 — Chunker + DCE. Walk dep graph, eliminate dead code, split into chunks. */
export function lunxChunk(graphJson: string, config: ChunkerConfig): ChunkerResult;

/** Phase 3.2 — Merge N source maps (SWC + LightningCSS) into one. */
export function mergeSourceMaps(maps: string[]): string;

export interface WatchEvent {
    /** "create" | "modify" | "delete" | "rename" | "error" */
    kind: string;
    paths: string[];
    timestamp: number;
}

/** Phase 3.3 — Native FS watcher (persistent instance). */
export class NativeWatcher {
    constructor();
    start(
        paths: string[],
        callback: (err: null | Error, event: WatchEvent) => void
    ): void;
    stop(): void;
}

/** Phase 3.3 — Convenience standalone watcher function. */
export function startWatcher(
    paths: string[],
    callback: (err: null | Error, event: WatchEvent) => void
): void;

/** Phase 4.1 — Incremental task graph types. */
export interface Task {
    id: string;
    inputs: string[];
    outputs: string[];
    fn_hash: string;
    cached: boolean;
}

export interface TaskPlan {
    tasks: Task[];
    total: number;
    cached_count: number;
    pending_count: number;
    plan_hash: string;
}

/**
 * Phase 4.1 — planBuild(manifestJson): TaskPlan
 * Computes an incremental build plan from manifest JSON.
 * Returns tasks in topological order with cache-hit flags.
 */
export function planBuild(manifestJson: string): TaskPlan;

declare const native: any;
export default native;
