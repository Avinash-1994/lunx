'use strict';
// CJS shim for native/index.js — used by Jest to avoid ESM transform issues
// with __dirname and native require() calls.

const path = require('path');
const fs = require('fs');

let nativeBinding = null;

// Try all known locations for the compiled .node binary
const candidates = [
    path.join(__dirname, 'lunx_native.win32-x64-msvc.node'),
    path.join(__dirname, 'lunx_native.win32-x64-gnu.node'),
    path.join(__dirname, 'lunx_native.linux-x64-gnu.node'),
    path.join(__dirname, 'lunx_native.linux-x64-musl.node'),
    path.join(__dirname, 'lunx_native.darwin-universal.node'),
    path.join(__dirname, 'lunx_native.darwin-arm64.node'),
    path.join(__dirname, 'lunx_native.darwin-x64.node'),
    path.join(__dirname, 'lunx_native.node'),
    path.join(__dirname, '..', 'lunx_native.node'),
    path.join(__dirname, '..', 'dist', 'lunx_native.node'),
    path.join(process.cwd(), 'native', 'lunx_native.win32-x64-msvc.node'),
    path.join(process.cwd(), 'native', 'lunx_native.linux-x64-gnu.node'),
    path.join(process.cwd(), 'native', 'lunx_native.darwin-universal.node'),
    path.join(process.cwd(), 'lunx_native.node'),
    path.join(process.cwd(), 'dist', 'lunx_native.node'),
];

for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
        try {
            nativeBinding = require(candidate);
            break;
        } catch (_e) {
            // try next
        }
    }
}

// JS fallback stubs — used when native binding is not available (CI without Rust build)
const stub = {
    BuildCache: class BuildCache {
        constructor() { }
        get(key) { return null; }
        set(key, value) { }
        invalidate(key) { }
        clear() { }
    },
    BuildOrchestrator: class BuildOrchestrator {
        constructor() { }
        async build(config) { return { success: true, modules: [], duration: 0 }; }
    },
    GraphAnalyzer: class GraphAnalyzer {
        constructor() { }
        analyze(graph) { return { cycles: [], order: [] }; }
    },
    NativeWorker: class NativeWorker {
        constructor(threads) { this.threads = threads; }
        async batchTransform(items) {
            return items.map(item => ({ code: item.content || '', map: null }));
        }
        async transform(code, options) { return { code, map: null }; }
    },
    PluginRuntime: class PluginRuntime {
        constructor() { }
        async runPlugin(plugin, context) { return context; }
    },
    BuildStage: { Load: 0, Transform: 1, Optimize: 2, Bundle: 3 },
    batchHash: (items) => items.map(() => 'stub-hash-' + Math.random().toString(36).slice(2)),
    benchmarkGraphAnalysis: () => ({ duration: 0 }),
    benchmarkParallelism: () => ({ duration: 0 }),
    benchmarkTransform: () => ({ duration: 0 }),
    createArtifactKey: (id) => `artifact:${id}`,
    createGraphKey: (id) => `graph:${id}`,
    createInputKey: (id) => `input:${id}`,
    createPlanKey: (id) => `plan:${id}`,
    fastHash: (data) => 'stub-hash-' + Buffer.from(String(data)).toString('hex').slice(0, 8),
    getOptimalParallelism: () => require('os').cpus().length || 4,
    helloRust: () => 'Hello from JS stub!',
    minifySync: (code) => code, // No-op fallback: return code unchanged
    normalizePath: (p) => p.replace(/\\/g, '/'),
    scanImports: (code) => [],
};

const binding = nativeBinding || stub;

if (!nativeBinding) {
    // Only warn once, not on every import
    if (!global.__lunx_native_warned) {
        global.__lunx_native_warned = true;
        process.stderr.write('[lunx] Native binding not found — using JS fallback stubs. Build/run `npm run build:native` to compile.\n');
    }
}

module.exports = binding;

// Named exports
module.exports.BuildCache = binding.BuildCache;
module.exports.BuildOrchestrator = binding.BuildOrchestrator;
module.exports.GraphAnalyzer = binding.GraphAnalyzer;
module.exports.NativeWorker = binding.NativeWorker;
module.exports.PluginRuntime = binding.PluginRuntime;
module.exports.batchHash = binding.batchHash;
module.exports.benchmarkGraphAnalysis = binding.benchmarkGraphAnalysis;
module.exports.benchmarkParallelism = binding.benchmarkParallelism;
module.exports.benchmarkTransform = binding.benchmarkTransform;
module.exports.BuildStage = binding.BuildStage;
module.exports.createArtifactKey = binding.createArtifactKey;
module.exports.createGraphKey = binding.createGraphKey;
module.exports.createInputKey = binding.createInputKey;
module.exports.createPlanKey = binding.createPlanKey;
module.exports.fastHash = binding.fastHash;
module.exports.getOptimalParallelism = binding.getOptimalParallelism;
module.exports.helloRust = binding.helloRust;
module.exports.minifySync = binding.minifySync;
module.exports.normalizePath = binding.normalizePath;
module.exports.scanImports = binding.scanImports;
