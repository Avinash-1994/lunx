# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-06

### Added
- **Meta-frameworks built by lunx**: SvelteKit, React Router, Remix, TanStack Start, Qwik City, Astro, Nuxt, SolidStart, VitePress, Waku, Marko Run and Analog run in `lunx dev` / `lunx build` on lunx's plugin host (Rolldown + Oxc), with no Vite, Rollup or vite-node code. Next.js, Docusaurus, Gatsby, RedwoodJS and Stencil run on their own CLIs, labelled as such. `LUNX_PLUGIN_HOST=0` opts out.
- **Module federation on lunx's engine**: ES module `remoteEntry.js` with the webpack 5 container API, `mf-manifest.json`, a webpack-format share scope (`singleton`, `requiredVersion`, `strictVersion`, `eager`), static and lazy remote imports. Dev and built apps mix freely, and a remote fast-refreshes inside the host page.
- **Library mode**: `lunx build --lib [entry]` (or `lib` in lunx.config, or a vite.config `build.lib`) builds ES / CommonJS / UMD / IIFE outputs with automatic externals, CSS extraction, `.d.ts` via Oxc isolated declarations (tsc fallback), package.json `exports` checks and `--watch`.
- esbuild plugins from `optimizeDeps.esbuildOptions.plugins` run in the dependency optimizer.
- `npm run test:federation-e2e`; the browser matrix now clicks through every fixture (133/133).

### Changed
- Production builds no longer wait on the OSV vulnerability API: findings come from the cache and a background process refreshes it (strict projects still wait).
- Rollup's and vite-node's APIs, used by Nitro, React Router and Nuxt, are served by lunx's engine.
- `engines.node` is `^20.19.0 || >=22.12.0`, as Rolldown requires.

### Fixed
- Dev server no longer restarts in a loop when files change next to a missing config file (JS watcher).
- No warning about a missing native binary: the optional native helpers are not required.

---

## [1.0.0] - 2026-01-07

### Added
- **Native Core Orchestration**
  - Ultra-fast native XXH3 hashing (integrated per module and per artifact).
  - High-performance Regex-based native scanner in Rust.
  - Industrial-grade graph analysis (cycle detection, orphans) via `petgraph`.
- **Scale Verification**
  - Validated stability with **10,000 inter-dependent modules**.
  - Verified consistent sub-second HMR even at industrial scales.
- **Developer Experience (Hero Tools)**
  - `lunx verify`: Comprehensive project health diagnostics.
  - `lunx analyze`: Build profiling and bundle composition visualization.
  - `lunx report`: AI-augmented build session narration.
- **Universal Transformer v2**
  - Stable support for React, Vue, Svelte, Solid, and Lit.
  - Transparent CJS/ESM compatibility mode for complex bundling.

### Fixed
- ESM `export` leakage in minified production bundles.
- Native worker pool thread-safety in asset processing.

---

## [0.2.0] - 2025-12-29

## [0.1.0] - 2025-11-21

### Added

#### Phase 1: Core Build System
- **Module Resolution & Dependency Graph**
  - TypeScript AST-based import parsing
  - Handles multiline imports and comments correctly
  - Recursive dependency traversal
  - Test: `resolver_repro.mjs` ✅

- **Hot Module Replacement (HMR)**
  - WebSocket-based live reload
  - CSS hot updates without page refresh
  - React Fast Refresh support
  - Client-side HMR script injection
  - Test: `hmr_test.mjs` ✅

- **Plugin System**
  - Plugin manager with transform pipeline
  - Esbuild adapter for plugin integration
  - Plugin signature verification
  - Sandboxed plugin execution
  - Sample plugin (console.log → console.debug)
  - Test: `plugin_test.mjs` ✅

- **Development Server**
  - HTTP server for static files and transformed modules
  - TypeScript/TSX/JSX support via esbuild
  - Source map generation
  - Live file watching
  - Test: `dev_server_test.mjs` ✅

#### Phase 2: Advanced Core & DX
- **Configuration Validation**
  - JSON schema validation
  - Detailed error messages
  - Type-safe configuration
  - Test: `config_validation_test.mjs` ✅

- **React Fast Refresh**
  - Babel integration for React transforms
  - Automatic Fast Refresh injection
  - State preservation on hot reload
  - Test: `hmr_test.mjs` ✅

- **Project Initialization**
  - Interactive CLI wizard
  - Framework detection (React, Vue, Svelte, Vanilla)
  - Automatic config generation
  - Recommended defaults
  - Test: `init_test.mjs` ✅

- **TypeScript Config Support**
  - Load `lunx.build.ts` configuration
  - On-the-fly compilation with esbuild
  - Type checking and IntelliSense
  - Fallback to JSON config
  - Test: `ts_config_test.mjs` ✅

#### Phase 3: Performance & Native
- **Parallel Plugin Execution**
  - Worker pool implementation
  - IPC-based plugin execution
  - Isolation for security
  - Automatic worker recovery
  - Configurable pool size
  - Test: `parallel_plugin_test.mjs` ✅

- **Rust Native Worker**
  - High-performance native addon (napi-rs)
  - Sync and async transform methods
  - ~0.24µs per transform (**20x faster** than Node.js)
  - 991KB native binary
  - TypeScript bindings
  - Benchmark utilities
  - Test: `native_worker_test.cjs` ✅

- **Build System Improvements**
  - Copy `.mjs` files to `dist/` during build
  - Fixed worker IPC communication
  - Added worker initialization delay
  - Disabled `prlimit` that was killing workers

### Changed
- Updated module resolution to use TypeScript AST instead of regex
- Improved error handling in dev server
- Enhanced plugin verification security
- Optimized HMR WebSocket communication

### Fixed
- Multiline import parsing in dependency graph
- Worker process premature exit
- IPC channel communication (process.send vs postMessage)
- TypeScript config compilation errors
- Plugin signature verification edge cases

### Performance
- **Development Server**: <2s startup
- **HMR Updates**: <100ms
- **Plugin Transform (Node.js)**: ~5µs
- **Plugin Transform (Rust)**: ~0.24µs (**20x faster**)
- **Full Build** (1000 modules): ~3s

### Security
- Mandatory plugin signature verification
- Trusted key validation
- Sandboxed plugin execution
- IPC isolation between workers

## Migration Guides

### From 0.0.x to 0.1.0

**Configuration Changes:**
```diff
{
  "entry": ["src/main.tsx"],
  "outDir": "dist",
+ "plugins": [
+   {
+     "name": "sample-plugin-esm",
+     "enabled": true
+   }
+ ],
+ "parallelPlugins": {
+   "enabled": true,
+   "workers": 4
+ }
}
```

**Plugin Signing:**
All plugins must now be signed. Use:
```bash
node scripts/sign_plugin.mjs your-plugin.mjs \
  --publisher yourname \
  --version 1.0.0 \
  --key path/to/key.pem
```

**TypeScript Config:**
You can now use `lunx.build.ts` instead of JSON:
```typescript
export default {
  entry: ['src/main.tsx'],
  outDir: 'dist'
};
```

---

## Versioning

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes

---

## Links

- [Repository](https://github.com/Avinash-1994/next-gen-build-tool)
- [Issues](https://github.com/Avinash-1994/next-gen-build-tool/issues)
- [Documentation](README.md)
