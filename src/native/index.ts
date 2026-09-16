import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

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

function jsTransformJs(code: string, filename: string, minify: boolean): string {
    const swc = _require('@swc/core');
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
            target: 'es2020',
            minify: minify ? { compress: true, mangle: true } : undefined,
        },
        minify,
        sourceMaps: false,
    });
    return result.code;
}

function jsTransformCss(code: string, filename: string, minify: boolean): string {
    try {
        const lightningcss = _require('lightningcss');
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
    const swc = _require('@swc/core');
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
        return { code: jsTransformJs(content, filepath, minify) };
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
    console.warn("[lunx] engine: js-fallback");
    console.warn("⚠️  [LUNX EXECUTOR] Native Rust binary not found/loadable. Falling back to JavaScript engine (@swc/core + LightningCSS).");
    console.warn("⚠️  [LUNX EXECUTOR] Performance will be degraded vs native. Rebuild with cargo + `npm run build:native`, or reinstall lunx-dev.");
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

function looksLikeNativeBinding(mod: any): boolean {
    if (!mod || typeof mod !== 'object') return false;
    if (typeof mod.helloRust !== 'function') return false;
    try {
        return String(mod.helloRust()) !== 'JS fallback';
    } catch {
        return false;
    }
}

function platformNativeName(): string {
    const { platform, arch } = process;
    // Mirror napi-rs binary naming (gnu linux is the common CI/publish target).
    if (platform === 'linux' && arch === 'x64') return 'lunx_native.linux-x64-gnu.node';
    if (platform === 'linux' && arch === 'arm64') return 'lunx_native.linux-arm64-gnu.node';
    if (platform === 'darwin' && arch === 'x64') return 'lunx_native.darwin-x64.node';
    if (platform === 'darwin' && arch === 'arm64') return 'lunx_native.darwin-arm64.node';
    if (platform === 'win32' && arch === 'x64') return 'lunx_native.win32-x64-msvc.node';
    return 'lunx_native.node';
}

function platformOptionalPackage(): string | null {
    const { platform, arch } = process;
    if (platform === 'linux' && arch === 'x64') return '@lunx/native-linux-x64-gnu';
    if (platform === 'linux' && arch === 'arm64') return '@lunx/native-linux-arm64-gnu';
    if (platform === 'darwin' && arch === 'arm64') return '@lunx/native-darwin-arm64';
    if (platform === 'darwin' && arch === 'x64') return '@lunx/native-darwin-x64';
    if (platform === 'win32' && arch === 'x64') return '@lunx/native-win32-x64-msvc';
    return null;
}

function tryLoadOptionalNativePackage(): any | null {
    const pkgName = platformOptionalPackage();
    if (!pkgName) return null;
    try {
        const loaded = _require(pkgName);
        if (looksLikeNativeBinding(loaded)) return loaded;
    } catch {
        // optionalDependency may be missing on unsupported platforms — OK
    }
    // Monorepo / pre-publish: packages/lunx-native-* next to the tool root
    try {
        const short = pkgName.replace('@lunx/', '');
        const candidates = [
            path.resolve(__dirname, `../../../packages/${short}/index.js`),
            path.resolve(__dirname, `../../packages/${short}/index.js`),
            path.resolve(process.cwd(), `packages/${short}/index.js`),
            path.resolve(process.cwd(), `node_modules/${pkgName}/index.js`),
        ];
        for (const c of candidates) {
            if (!fs.existsSync(c)) continue;
            const loaded = _require(c);
            if (looksLikeNativeBinding(loaded)) return loaded;
        }
    } catch { /* ignore */ }
    return null;
}

try {
    const platName = platformNativeName();
    let foundNative = '';
    let loadError: unknown = null;

    // 1) Preferred: optional platform package (keeps lunx-dev ≤1.6MB on npm)
    const fromOptional = tryLoadOptionalNativePackage();
    if (fromOptional) {
        native = fromOptional;
        foundNative = platformOptionalPackage() || 'optional-native';
        engineUsed = 'native';
    }

    // 2) Local/dev fallback: lunx_native.node beside the repo (cargo build)
    if (!foundNative) {
        const searchRoots = [
            __dirname,
            path.resolve(__dirname, '..'),
            path.resolve(__dirname, '../..'),
            path.resolve(__dirname, '../../..'),
            path.resolve(__dirname, '../../../native'),
            path.resolve(__dirname, '../../native'),
            path.resolve(__dirname, '../native'),
            process.cwd(),
            path.resolve(process.cwd(), 'dist'),
            path.resolve(process.cwd(), 'dist/native'),
            path.resolve(process.cwd(), 'native'),
        ];

        const nativeCandidates: string[] = [];
        for (const root of searchRoots) {
            nativeCandidates.push(
                path.join(root, 'lunx_native.node'),
                path.join(root, platName),
            );
        }

        for (const c of nativeCandidates) {
            if (!fs.existsSync(c)) continue;
            try {
                const loaded = _require(c);
                if (!looksLikeNativeBinding(loaded)) {
                    loadError = new Error(`${c} loaded but is not the Rust N-API binding`);
                    continue;
                }
                native = loaded;
                foundNative = c;
                engineUsed = 'native';
                break;
            } catch (err) {
                loadError = err;
            }
        }
    }

    if (!foundNative) {
        if (loadError) {
            console.warn(`⚠️  [LUNX EXECUTOR] Native binary found but failed to load: ${loadError instanceof Error ? loadError.message : String(loadError)}`);
        }
        native = getJSFallback();
        engineUsed = 'js';
    } else {
        console.log('[lunx] engine: rust-native');
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
