
import { DependencyGraph } from '../../resolve/graph.js';

// 6.1 EngineInfo
export type EngineInfo = {
    name: "Lunx";
    version: string;
    commit?: string;
    buildTime?: string; // Observational only
};

// 6.2 BuildContext
export type BuildMode = 'dev' | 'build' | 'ci' | 'debug' | 'production';
export type BuildTarget = 'browser' | 'node' | 'edge';

export interface BuildContext {
    engine: EngineInfo;
    mode: BuildMode;
    target: BuildTarget;
    rootDir: string;
    env: Record<string, string>;
    graph: DependencyGraph;
    graphHash: string;
    cache: BuildCache;
    config: ResolvedConfig;
    pluginManager: any; // PluginManager (avoid circular dep)
}

// 6.3 InputFingerprint
export type InputFingerprint = {
    sourceFiles: {
        path: string;
        contentHash: string;
    }[];
    configHash: string;
    engineFingerprint: string;
    inputHash: string; // Master hash
};

// 6.4 BuildPlan
export interface ChunkPlan {
    id: string; // Unique ID
    entry: string; // Entry module ID
    modules: string[]; // List of module IDs
    outputName: string;
}

export interface AssetPlan {
    id: string;
    sourcePath: string;
    outputName: string;
}

export interface BuildPlan {
    planId: string; // canonicalHash(plan content)
    target: BuildTarget;
    chunks: ChunkPlan[];
    assets: AssetPlan[];
    executionOrder: string[];
}

// 6.5 ExecutionPlan
export type ExecutionPlan = {
    sequential: string[];
    parallelGroups: string[][];
};

// 6.6 BuildArtifact
export interface BuildArtifact {
    id: string; // contentHash
    type: 'js' | 'css' | 'asset' | 'map';
    fileName: string;
    /** Graph entry that produced this chunk, relative to the project root when available. */
    entry?: string;
    dependencies: string[];
    source?: string | Uint8Array;
    modules?: Array<{
        id: string;
        size: number;
        originalSize: number;
    }>;
}

// 6.7 BuildFingerprint
export type BuildFingerprint = {
    engineVersion: string;
    graphHash: string;
    planHash: string;
    inputHash: string;
    outputHash: string;
    target: string;
    buildTime?: string;
};

// Cache
export interface CachedResult {
    hash: string;
    artifact: BuildArtifact;
}

export interface BuildCache {
    get(key: string): CachedResult | null | Promise<CachedResult | null>;
    set(key: string, value: CachedResult): void | Promise<void>;
    clear(): void | Promise<void>;
    close(): void | Promise<void>;
}

// Configuration
export interface ResolvedConfig {
    entryPoints: string[];
    /** Source HTML shells to rewrite at emit time (index.html, src/index.html, ...). */
    htmlTemplates?: string[];
    outputDir: string;
    publicPath: string;
    splittingStrategy: 'route' | 'module';
    hashing: 'content';
    sourceMaps: boolean | 'inline' | 'external' | 'hidden';
    minify?: boolean;
    cssModules?: boolean;
    federation?: any;
}

// Error Handling
export interface BuildError {
    code: string;
    message: string;
    module?: string;
    stage: 'init' | 'fingerprint' | 'graph' | 'plan' | 'parallel_plan' | 'determinism' | 'execute' | 'optimize' | 'emit' | 'fingerprint_output' | 'audit' | 'unknown';
}

// Explain Mode
export interface ExplainEvent {
    stage: string;
    decision: string;
    reason: string;
    name?: string;
    id?: string;
    data?: any;
    timestamp?: number;
}

// Hot Reload
export type DeltaGraph = {
    added: string[];
    modified: string[];
    removed: string[];
}

export type HotReloadContext = {
    baseGraphHash: string;
    deltaGraph: DeltaGraph;
    affectedNodes: string[];
    affectedChunks: string[];
}
