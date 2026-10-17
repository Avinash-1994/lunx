import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { lightningcss as loadLightningcss } from '../lib/lightningcss.js';
import { loadNativeBinding } from './binding.js';

/**
 * Inlined JS fallback graph analyzer.
 * Kept here intentionally to avoid a forbidden cross-boundary import from
 * core/graph into the native layer. See docs/internal/EXTENSION_SURFACE.md.
 */
class JSGraphAnalyzer {
    private nodes: Map<string, string[]> = new Map();

    addBatch(ids: string[], edges: string[][]): void {
        for (let i = 0; i < ids.length; i++) {
            this.nodes.set(ids[i], edges[i] || []);
        }
    }

    detectCycles(): { cycle: string[]; entryPoint: string }[] {
        const cycles: { cycle: string[]; entryPoint: string }[] = [];
        const visited = new Set<string>();
        const onStack = new Set<string>();
        const path: string[] = [];
        const stack: { node: string; childIndex: number }[] = [];

        for (const startNode of this.nodes.keys()) {
            if (visited.has(startNode)) continue;
            stack.push({ node: startNode, childIndex: 0 });
            visited.add(startNode);
            onStack.add(startNode);
            path.push(startNode);

            while (stack.length > 0) {
                const peek = stack[stack.length - 1];
                const { node, childIndex } = peek;
                const deps = this.nodes.get(node) || [];

                if (childIndex < deps.length) {
                    peek.childIndex++;
                    const dep = deps[childIndex];
                    if (!visited.has(dep)) {
                        visited.add(dep);
                        onStack.add(dep);
                        path.push(dep);
                        stack.push({ node: dep, childIndex: 0 });
                    } else if (onStack.has(dep)) {
                        const cycleStart = path.indexOf(dep);
                        if (cycleStart !== -1) {
                            cycles.push({ cycle: path.slice(cycleStart), entryPoint: dep });
                        }
                    }
                } else {
                    onStack.delete(node);
                    path.pop();
                    stack.pop();
                }
            }
        }
        return cycles;
    }

    findOrphanedNodes(entryPoints: string[]): string[] {
        const reachable = new Set<string>(entryPoints);
        const queue: string[] = [...entryPoints];
        while (queue.length > 0) {
            const node = queue.shift()!;
            for (const dep of (this.nodes.get(node) || [])) {
                if (!reachable.has(dep)) { reachable.add(dep); queue.push(dep); }
            }
        }
        return [...this.nodes.keys()].filter(n => !reachable.has(n));
    }

    analyze(entryPoints: string[]) {
        const cycles = this.detectCycles();
        let totalEdges = 0;
        for (const deps of this.nodes.values()) totalEdges += deps.length;
        return {
            hasCycles: cycles.length > 0,
            cycles,
            orphanedNodes: this.findOrphanedNodes(entryPoints),
            entryPoints,
            totalNodes: this.nodes.size,
            totalEdges
        };
    }

    nodeCount(): number { return this.nodes.size; }
    edgeCount(): number {
        let c = 0;
        for (const d of this.nodes.values()) c += d.length;
        return c;
    }
    clear(): void { this.nodes.clear(); }
}

const _require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let native: any;
let engineUsed: 'native' | 'js' = 'js';

/**
 * Without the Rust engine, @swc/core compiles every module, so when its native
 * addon will not load there is nothing left to fall back to. SWC's own message
 * for that is just "Failed to load native binding", which names neither the
 * package at fault nor a remedy, so wrap it once here.
 */
function loadSwc(): any {
    try {
        return _require('@swc/core');
    } catch (err: any) {
        const detail = err?.message ? String(err.message).split('\n')[0] : 'unknown error';
        throw new Error(
            [
                `The legacy build engine (module federation, SSR and node targets) compiles with @swc/core, which is not installed or would not load (${detail}).`,
                '  - Install it:  npm i -D @swc/core',
                '  - On Windows, @swc/core 1.16.x can reject its own cache directory over',
                '    directory permissions; "@swc/core": "~1.15.24" is a known-good version.',
                '  - Or build the Rust engine, which takes @swc/core off this path:',
                '    npm run build:native',
            ].join(String.fromCharCode(10))
        );
    }
}

function jsTransformJs(
    code: string,
    filename: string,
    minify: boolean,
    jsxImportSource?: string,
    moduleType?: 'commonjs' | 'es6',
): string {
    const swc = loadSwc();
    const ext = path.extname(filename).toLowerCase();
    const isTs = ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts';
    const isJsx = ext === '.tsx' || ext === '.jsx';
    const result = swc.transformSync(code, {
        filename,
        jsc: {
            parser: {
                syntax: isTs ? 'typescript' : 'ecmascript',
                tsx: isJsx,
                jsx: !isTs && isJsx,
                decorators: true,
            },
            // SWC defaults to the classic runtime, which emits
            // `React.createElement` without importing React. Automatic is what
            // React >= 17, Preact and every modern toolchain expect.
            transform: isJsx
                ? { react: { runtime: 'automatic', importSource: jsxImportSource } }
                : undefined,
            target: 'es2020',
            minify: minify ? { compress: true, mangle: true } : undefined,
        },
        // The production bundler wraps every module in a CommonJS factory
        // (module, exports, require), so ESM syntax has to be lowered here.
        // Leaving `import` in place emitted bundles that died with
        // "'import' and 'export' may only appear at the top level".
        module: moduleType ? { type: moduleType, strictMode: false } : undefined,
        minify,
        sourceMaps: false,
    });
    return result.code;
}

function jsTransformCss(code: string, filename: string, minify: boolean): string {
    try {
        const lightningcss = loadLightningcss();
        const res = lightningcss.transform({
            filename,
            code: Buffer.from(code),
            minify,
        });
        return Buffer.from(res.code).toString('utf8');
    } catch (err) {
        console.warn(`⚠️  [LUNX EXECUTOR] CSS fallback failed (${err instanceof Error ? err.message : String(err)}). Returning original CSS.`);
        return code;
    }
}

function jsMinifySync(code: string): string {
    const swc = loadSwc();
    const result = swc.minifySync(code, {
        compress: true,
        mangle: true,
        module: true,
    });
    return result.code;
}

class JSNativeWorker {
    constructor(_poolSize?: number) {}

    transformSync(configOrCode: any, maybePath?: string): { code: string } {
        let content: string;
        let filepath: string;
        let loader: string;
        let minify = false;
        if (typeof configOrCode === 'string') {
            content = configOrCode;
            filepath = maybePath || 'input.js';
            loader = path.extname(filepath).slice(1) || 'js';
        } else {
            content = configOrCode.content;
            filepath = configOrCode.path || 'input.js';
            loader = configOrCode.loader || path.extname(filepath).slice(1) || 'js';
            minify = !!configOrCode.minify;
        }
        if (loader === 'css') return { code: jsTransformCss(content, filepath, minify) };
        if (loader === 'mjs' || loader === 'cjs') loader = 'js';
        return {
            code: jsTransformJs(
                content,
                filepath,
                minify,
                (configOrCode as any)?.jsxImportSource,
                (configOrCode as any)?.module,
            ),
        };
    }

    async batchTransform(items: any[]): Promise<{ code: string }[]> {
        return items.map((item) => this.transformSync(item));
    }

    async batchTransformCss(items: any[]): Promise<{ code: string }[]> {
        return items.map((item) => this.transformSync({ ...item, loader: 'css' }));
    }

    processFile() { return null; }
    invalidate() {}
    rebuild() { return []; }
}

function jsScanImports(code: string): string[] {
    const out = new Set<string>();
    const re = /(?:import|export)\s+(?:[^'"\n;]+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
        const spec = m[1] || m[2] || m[3];
        if (spec) out.add(spec);
    }
    return [...out];
}

class JSBuildCache {
    private store = new Map<string, string>();
    constructor(_cachePath?: string) {}
    get(key: string) { return this.store.get(key) || null; }
    set(key: string, value: string) { this.store.set(key, value); }
    delete(key: string) { this.store.delete(key); }
    has(key: string) { return this.store.has(key); }
    batchSet(entries: Record<string, string>) { Object.entries(entries).forEach(([k, v]) => this.store.set(k, v)); }
    clearTarget(_target: string) { this.store.clear(); return 0; }
    clearAll() { this.store.clear(); }
    getStats() { return { totalEntries: this.store.size, hits: 0, misses: 0, hitRate: 0, sizeBytes: 0 }; }
    compact() {}
    close() { this.store.clear(); }
}

class JSBuildOrchestrator {
    parallelism: number;
    constructor(parallelism?: number) {
        this.parallelism = parallelism || 1;
    }
    async logEvent() {}
    async getEvents() { return []; }
    async clearEvents() {}
    async executeParallel(taskCount: number) {
        return { totalTasks: taskCount, completedTasks: taskCount, failedTasks: 0, totalDurationMs: 0, parallelism: this.parallelism };
    }
    processParallelSync(items: string[]) { return items; }
    generateStableId(content: string, prefix: string) {
        return `${prefix}:${_require('crypto').createHash('sha256').update(content).digest('hex').slice(0, 16)}`;
    }
    batchGenerateIds(items: string[], prefix: string) {
        return items.map((item) => this.generateStableId(item, prefix));
    }
    async getStats() {
        return { totalTasks: 0, completedTasks: 0, failedTasks: 0, totalDurationMs: 0, parallelism: this.parallelism };
    }
    shutdown() {}
}

function wrapNativeWorker(Orig: any) {
    return class CompatibleNativeWorker {
        private inner: any;
        constructor(poolSize?: number) {
            this.inner = new Orig(poolSize);
        }
        transformSync(configOrCode: any, maybePath?: string): any {
            if (typeof configOrCode === 'string') {
                const filepath = maybePath || 'input.js';
                let loader = path.extname(filepath).slice(1) || 'js';
                if (loader === 'mjs' || loader === 'cjs' || loader === 'mts' || loader === 'cts') loader = 'js';
                const result = this.inner.transformSync({
                    content: configOrCode,
                    path: filepath,
                    loader,
                    minify: false,
                });
                return typeof result === 'string' ? result : (result?.code ?? configOrCode);
            }
            return this.inner.transformSync(configOrCode);
        }
        batchTransform(items: any[]) {
            return this.inner.batchTransform(items);
        }
        batchTransformCss(items: any[]) {
            if (typeof this.inner.batchTransformCss === 'function') return this.inner.batchTransformCss(items);
            if (typeof this.inner.batch_transform_css === 'function') return this.inner.batch_transform_css(items);
            return this.inner.batchTransform(items.map((item: any) => ({ ...item, loader: 'css' })));
        }
        processFile(...args: any[]) { return this.inner.processFile?.(...args) ?? null; }
        invalidate(...args: any[]) { return this.inner.invalidate?.(...args); }
        rebuild(...args: any[]) { return this.inner.rebuild?.(...args) ?? []; }
    };
}

function getJSFallback() {
    const crypto = _require('crypto');
    // The optional native helpers (file watcher, build cache) are not installed for
    // this platform. Everything works without them; say so only when asked.
    if (process.env.LUNX_DEBUG) console.warn("[lunx] engine: js-fallback (optional native helpers not installed for this platform)");
    return {
        GraphAnalyzer: JSGraphAnalyzer,
        BuildOrchestrator: JSBuildOrchestrator,
        BuildCache: JSBuildCache,
        PluginRuntime: class {
            constructor() { throw new Error('WASM plugin runtime requires the native binary'); }
        },
        fastHash: (s: string) => crypto.createHash('sha256').update(s).digest('hex').substring(0, 16),
        batchHash: (sa: string[]) => sa.map((s: string) => crypto.createHash('sha256').update(s).digest('hex').substring(0, 16)),
        scanImports: jsScanImports,
        normalizePath: (s: string) => s.replace(/\\/g, '/'),
        transformCss: jsTransformCss,
        transformJs: jsTransformJs,
        minifySync: jsMinifySync,
        NativeWorker: JSNativeWorker,
        NativeWatcher: undefined,
        helloRust: () => "JS fallback",
        getOptimalParallelism: () => Math.max(1, (_require('os').cpus() || []).length || 1),
        benchmarkParallelism: () => ({}),
        createInputKey: (filePath: string, contentHash: string) => `input:${filePath}:${contentHash}`,
        createGraphKey: (graphHash: string) => `graph:${graphHash}`,
        createPlanKey: (planHash: string, target: string) => `plan:${target}:${planHash}`,
        createArtifactKey: (artifactId: string, target: string) => `artifact:${target}:${artifactId}`,
    };
}

try {
    const found = loadNativeBinding();
    if (found.binding) {
        native = found.binding;
        engineUsed = 'native';
        console.log('[lunx] engine: rust-native');
    } else {
        if (found.error) {
            console.warn(`⚠️  [LUNX EXECUTOR] Native binary found but failed to load: ${found.error instanceof Error ? found.error.message : String(found.error)}`);
        }
        native = getJSFallback();
        engineUsed = 'js';
    }
} catch (e) {
    console.warn(`⚠️  [LUNX EXECUTOR] Engine failure: ${e instanceof Error ? e.message : String(e)}`);
    native = getJSFallback();
    engineUsed = 'js';
}

if (native?.NativeWorker) {
    native.NativeWorker = wrapNativeWorker(native.NativeWorker);
}

const OriginalGraphAnalyzer = native.GraphAnalyzer;
native.GraphAnalyzer = class DebugWrappedGraphAnalyzer extends OriginalGraphAnalyzer {
    private __spy_ids: string[] = [];
    private __spy_edges: string[][] = [];

    addBatch(ids: string[], edges: string[][]) {
        if (process.env.LUNX_DEBUG_GRAPH) {
            this.__spy_ids.push(...ids);
            this.__spy_edges.push(...edges);
        }
        return super.addBatch(ids, edges);
    }

    analyze(entryPoints: string[]) {
        if (process.env.LUNX_DEBUG_GRAPH) {
            this._dumpSnapshot(entryPoints);
        }
        if (typeof super.analyze === 'function') {
            return super.analyze(entryPoints);
        }
        return null;
    }

    detectCycles() {
        if (process.env.LUNX_DEBUG_GRAPH && typeof super.analyze !== 'function') {
            this._dumpSnapshot([]); // some consumers just call detectCycles
        }
        return super.detectCycles();
    }

    private _dumpSnapshot(entryPoints: string[]) {
        try {
            const fs = _require('fs');
            const data = {
                entry_points: entryPoints,
                ids: this.__spy_ids,
                edges: this.__spy_edges
            };
            fs.writeFileSync('snapshot.json', JSON.stringify(data, null, 2), 'utf8');
            console.warn('⚠️  [LUNX DEBUG] Graph snapshot written to snapshot.json');
        } catch(e) {}
    }
};

export const {
    GraphAnalyzer,
    BuildOrchestrator,
    BuildCache,
    PluginRuntime,
    fastHash,
    batchHash,
    scanImports,
    normalizePath,
    transformCss,
    transformJs,
    minifySync,
    NativeWorker,
    helloRust,
    NativeWatcher,
    startWatcher,
    lunxChunk,
    mergeSourceMaps,
    prebundle,
    prebundlePut,
    planBuild,
    getOptimalParallelism,
    benchmarkParallelism,
    createInputKey,
    createGraphKey,
    createPlanKey,
    createArtifactKey,
} = native;

export { NativeWorker as RustNativeWorker, engineUsed };
export default native;
