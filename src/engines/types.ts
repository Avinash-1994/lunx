/**
 * Lunx's engine contracts. Everything in lunx that compiles or bundles code
 * goes through these two interfaces, never through a specific tool, so the
 * engine underneath can be replaced (e.g. by lunx's own Rust bundler in
 * native/) without touching the dev server, build, pre-bundler or loaders.
 *
 * Plugins use the Rollup plugin shape (resolveId / load / transform /
 * renderChunk / generateBundle, with optional hook filters): it is the de
 * facto standard that Vite, Rollup and Rolldown plugins already speak, so any
 * engine that implements `Bundler` must accept it.
 */

// ── Compiler: one file in, one file out ──────────────────────────────────────

export type Lang = 'js' | 'jsx' | 'ts' | 'tsx';

export interface CompileOptions {
    /** Defaults from the file extension. */
    lang?: Lang;
    jsx?: 'preserve' | {
        runtime?: 'automatic' | 'classic';
        importSource?: string;
        pragma?: string;
        pragmaFrag?: string;
        development?: boolean;
        /** Emit React Refresh registrations ($RefreshReg$ / $RefreshSig$). */
        refresh?: boolean;
    };
    /** TypeScript's experimentalDecorators (Angular, Lit, MobX…). */
    legacyDecorators?: boolean;
    /** Emit decorator metadata (Angular DI). */
    decoratorMetadata?: boolean;
    define?: Record<string, string>;
    /** 'inline' appends a data-URL map comment. */
    sourcemap?: boolean | 'inline';
    target?: string;
}

export interface CompileResult {
    code: string;
    map?: string;
}

export interface Compiler {
    readonly name: string;
    /** Strip types, compile JSX, apply defines. Output stays ES modules. */
    compile(file: string, code: string, opts?: CompileOptions): CompileResult;
    minify(file: string, code: string, opts?: { mangle?: boolean; compress?: boolean }): CompileResult;
    /** ESTree-compatible AST with node.start / node.end offsets. */
    parse(file: string, code: string, lang?: Lang, sourceType?: 'module' | 'script'): any;
}

// ── Bundler: a module graph in, chunks and assets out ───────────────────────

/** A Rollup-shaped plugin object. */
export type BundlerPlugin = { name: string; [hook: string]: unknown };

export interface BundleInput {
    input: string | string[] | Record<string, string>;
    cwd?: string;
    platform: 'browser' | 'node' | 'neutral';
    plugins?: BundlerPlugin[];
    /** Return true to keep an import out of the bundle. */
    external?: (id: string) => boolean;
    define?: Record<string, string>;
    jsx?: { runtime: 'automatic' | 'classic'; importSource?: string };
    /** Package export conditions, in priority order. */
    conditions?: string[];
    alias?: Record<string, string>;
    extensions?: string[];
    /** tsconfig.json used for paths and decorator settings. */
    tsconfig?: string;
    /** Suppress all bundler warnings (internal bundles: pre-bundling, config loading). */
    quiet?: boolean;
    /** Called for warnings; return false to drop one. */
    onWarning?: (warning: { code?: string; message: string }) => boolean | void;
}

export interface BundleOutputOptions {
    dir?: string;
    file?: string;
    format: 'es' | 'cjs' | 'iife' | 'umd';
    /** Global name for iife/umd. */
    name?: string;
    entryFileNames?: string;
    chunkFileNames?: string;
    assetFileNames?: string;
    minify?: boolean;
    sourcemap?: boolean | 'inline' | 'hidden';
    inlineDynamicImports?: boolean;
    /** Named chunks: modules whose id matches go into that chunk. */
    chunkGroups?: Array<{ name: string; test: RegExp }>;
}

export interface OutputChunk {
    type: 'chunk';
    fileName: string;
    name: string;
    code: string;
    isEntry: boolean;
    facadeModuleId: string | null;
    /** Static imports of other chunks (file names). */
    imports: string[];
    moduleIds: string[];
}

export interface OutputAsset {
    type: 'asset';
    fileName: string;
    source: string | Uint8Array;
}

export type OutputItem = OutputChunk | OutputAsset;

export interface Bundler {
    readonly name: string;
    /** False when the engine cannot load here (e.g. a missing native binding). */
    available(): Promise<boolean>;
    /**
     * Bundle `input`. With `write`, files go to output.dir / output.file;
     * either way the produced chunks and assets are returned.
     */
    bundle(input: BundleInput, output: BundleOutputOptions, write?: boolean): Promise<OutputItem[]>;
}
