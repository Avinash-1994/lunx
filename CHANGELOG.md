# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **CSS code splitting**, as in Vite: CSS that only lazy chunks import goes in their own stylesheets, and a lazy chunk's `import()` resolves once its CSS has loaded (no flash of unstyled content); the page's stylesheet keeps what loads up front. `build.cssCodeSplit: false` (also read from a vite.config) keeps one file.
- **Build output audit** (`npm run test:parity`): the same app per framework (vanilla, React, Preact, Vue, Svelte, Solid, Lit, and a two-page React app with lazy routes, base path and source maps) built by lunx and Vite 8, both run in Chromium, outputs compared. lunx's JS is smaller in every one; every probe passes.
- **Module federation with webpack 5 and Rspack** (`npm run test:mf-interop`): lunx hosts with webpack / Rspack remotes, webpack / Rspack hosts with lunx remotes, and shells mixing all three, in Chromium with React shared as a singleton.
- **Built in, no plugin needed**: SVG files as components (`import Logo from './logo.svg?react'` for React and Preact, `?component` for the app's framework, Vue included), in place of `vite-plugin-svgr` / `vite-svg-loader`; `.wasm?init` imports, as in Vite; `%ENV%` values in `index.html` (`%VITE_APP_TITLE%`, `%MODE%`…), as in Vite. An installed `vite-plugin-svgr` keeps `?react`. Checked in Chromium by the plugin matrix (`builtin-*` scenarios).
- **PWA, built in**: `pwa: { manifest }` in lunx.config writes `manifest.webmanifest`, `registerSW.js` and a `sw.js` that precaches the finished build (after SRI), serves it cache-first, falls back to `index.html` for offline navigations and drops old caches on deploy. No Workbox. The plugin matrix checks it offline in Chromium. An installed `vite-plugin-pwa` keeps the job.
- **Type errors in dev, built in**: `server: { typecheck: true }` runs the project's `tsc` (or `vue-tsc`) in watch mode beside `lunx dev`; each pass's errors go to the terminal and to a Type Errors tab in the overlay, and clear once fixed. In place of `vite-plugin-checker`.
- The error overlay shows compiler messages as text (`Promise<string>` was parsed as markup) and links build errors to their file.
- `electron` and `pwa` are accepted in lunx.config (the config check rejected `electron` as an unknown key).
- `lunx-dev/client` types: assets, `?raw` / `?url` / `?inline` / `?react` / `.wasm?init`, CSS modules, `import.meta.env`, `import.meta.hot`, `import.meta.glob`. TypeScript app starters reference them in `src/lunx-env.d.ts`.
- **Electron, built in**: in a project with `electron` installed, lunx builds `electron/main.*` and `electron/preload.*` with Rolldown into `dist-electron/` (the main process as the package's module type with `dependencies` external; the preload as one CommonJS file for sandboxed renderers), alongside the renderer, which gets `base: './'`. `lunx dev` starts Electron on the dev server (`LUNX_DEV_SERVER_URL`), restarts it when the main process changes and reloads the window when the preload does; `lunx preview` runs the build in Electron. `electron: { main, preload, outDir }` or `false` in lunx.config; `LUNX_ELECTRON_ARGS` for Electron switches. `lunx create --template electron` (React renderer, main process, preload) uses it; the template matrix checks it in Electron. The old Electron adapter's process spawning (broken under ESM) is gone.
- `vite-plugin-electron` projects run on lunx unchanged: `build.lib`, `build.watch` and `platform` in the plugin host's `build()`, `closeBundle` after each watch rebuild, the dev server's `listening` event for plugins, a plugin's `config`-hook `base`, and relative `base: './'` (it was rewritten to `/./`).
- **Vite plugins in apps**, with Vite's lifecycle on lunx's own build and dev server (they used to reach the build as bare Rollup plugins, and dev ignored them): `apply`, `enforce`, `config`, `configResolved`, virtual modules, `transformIndexHtml`, stylesheet transforms around lunx's CSS compiler, `configureServer`, `writeBundle` / `closeBundle` once the app is on disk, Vite's asset placeholders, and HMR for modules a plugin built from other files (Tailwind). `scripts/vite-plugins-matrix.mjs` checks 17 popular plugins in Chromium.

### Changed
- Vue and Svelte component CSS goes to the app's stylesheet in a build (it was injected from JavaScript: a flash of unstyled content, and blocked by a strict CSP), and to `style.css` in library builds.
- Vue `<style lang="scss" | "sass" | "less" | "stylus">` and `<style src>` are compiled (they reached the browser as-is), and `<style module>` gives `$style` / named modules. Svelte `<style lang="scss" | "less" | "stylus">` is compiled too.
- A Vue or Svelte compile error fails the build with the compiler's message, position and code frame (the uncompiled source used to reach the bundler, which reported a JavaScript syntax error in it), and source errors are no longer labelled "unexpected error, please report it".
- A lunx remote's modules carry `__esModule`, so webpack and Rspack hosts read their default export (React.lazy received the whole module before).
- A `lunx.config` next to a `vite.config` no longer hides it: the Vite config applies underneath (settings and plugins), `lunx.config` wins where both set something, and a plugin listed in both runs once. Adding a `lunx.config` for `pwa` or `electron` used to drop the Vite plugins.
- Faster builds of big apps (2,000 components: from 1.45× to ~1.1× the time of Rolldown alone): the CSS cascade walk only follows the modules that lead to a stylesheet (one call into Rust per module before); the first build's input scan uses synchronous stats, yielding as it goes (~4× less CPU taken from Rolldown's threads); a build whose output was removed or changed no longer reads every input before it starts; apps without Vue, Svelte or JS-compiled JSX skip the component-compiler file scan.
- A desktop app's framework is its renderer's (React…), not Electron / Tauri.
- `plugins` in lunx.config may hold promises and nested arrays, as in Vite.
- **Parallel component compilation**: production builds of projects with 100+ Vue / Svelte / compiled-JSX components compile them on worker threads, starting before Rolldown asks for them. 1,000 Vue SFCs build cold in ~1.6–2.0 s instead of ~3.1 s on 4 cores; output is identical. `LUNX_COMPILE_WORKERS=0` turns it off, `=N` sets the pool size.
- Vue compiles in production mode without unused source maps, and the compiler loads with `require()`.
- **Faster HMR**: a save reaches the browser without stacked debounces (small app: 53 → 36 ms; Vite 46 ms).
- Faster cold builds: the compile cache is one file per build, first builds read the build-cache inputs in the background, brotli precompression defaults to quality 6 (≈1% larger than 9, 3× faster), and the OSV cache refresh starts after the build.

- **Faster startup and cold builds** (small app: dev boot 365 → 263 ms, cold build 390 → 349 ms; Rspack 389 / 409 ms):
  - configs Node can run as they are (ESM without local imports, TypeScript with type stripping) are imported directly instead of bundled with Rolldown first; `LUNX_CONFIG_BUNDLE=1` restores bundling;
  - the lockfile / CVE checks start once Rolldown has the module graph, while it minifies, and precompression runs alongside the post-build steps;
  - OSV advisories are cached once per machine (`LUNX_ADVISORY_CACHE_DIR` to move it), so new checkouts and monorepo packages no longer each start a refresh process;
  - lightningcss, `child_process`, `https` and `zlib` load only when needed, and lightningcss without detect-libc.

- **`lunx create` rebuilt**: one scaffolder behind `lunx create`, `create-lunx` and `lunx bootstrap`, with 26 starters: React, Vue, Svelte, Solid, Preact, Lit, Alpine, Angular, Qwik and vanilla apps (TypeScript or `--no-ts`, most with `--tailwind`); Next.js, Nuxt, SvelteKit, Astro, React Router, TanStack Start, SolidStart, Qwik City, VitePress, Waku, Analog, Remix, Docusaurus and Marko Run; a library and an edge function. `npm run test:templates` scaffolds each from the packed package, installs it from npm, type-checks, builds, and opens the dev and preview servers in a browser.
- `npx lunx-dev create my-app` works: the package has a `lunx-dev` bin.
- Lit compiles with Oxc (legacy decorators, `useDefineForClassFields: false` semantics) instead of TypeScript, which Lit projects no longer need installed.

### Fixed
- Scaffolded projects depended on packages that are not on npm (`lunx@^2.0.0`, `@lunx/plugin-*`, `@lunx/framework-*`), so `npm install` failed in every new project; several templates (Nuxt, SvelteKit, Electron, Tauri…) were placeholder pages.
- `lunx-dev` declared `react@^19`, `vue@^3.5` and others as optional peer dependencies, which npm enforces: installing it in a React 18 project failed with ERESOLVE. It declares none now.
- `lunx preview` in React Router and Remix projects ran a command that does not exist (`react-router start`) or the dev server (`remix vite:dev`); it runs `react-router-serve` / `remix-serve` on the build. Qwik City builds also build `src/entry.preview`, which `vite preview` serves.
- Code compiled twice (a framework transform, then the final pass) declared its decorator helpers twice, a syntax error: decorated Lit components did not load in dev.
- Configs in symlinked directories (macOS' `/var` → `/private/var`) lost their stubbed imports and fell back to bundling.
- `index.html.gz` / `.br` are written after SRI is injected; they used to hold the page without its `integrity` attributes.
- Production Vue bundles no longer embed each component's absolute path.
- The adapter log no longer calls frameworks lunx builds "upstream, not a Lunx SSR engine".

## [1.1.0] - 2026-10-06

### Added
- **Meta-frameworks built by lunx**: SvelteKit, React Router, Remix, TanStack Start, Qwik City, Astro, Nuxt, SolidStart, VitePress, Waku, Marko Run and Analog run in `lunx dev` / `lunx build` on lunx's plugin host (Rolldown + Oxc), with no Vite, Rollup or vite-node code. Next.js, Docusaurus, Gatsby, RedwoodJS and Stencil run on their own CLIs, labelled as such. `LUNX_PLUGIN_HOST=0` opts out.
- **Module federation on lunx's engine**: ES module `remoteEntry.js` with the webpack 5 container API, `mf-manifest.json`, a webpack-format share scope (`singleton`, `requiredVersion`, `strictVersion`, `eager`), static and lazy remote imports. Dev and built apps mix freely, and a remote fast-refreshes inside the host page.
- **Library mode**: `lunx build --lib [entry]` (or `lib` in lunx.config, or a vite.config `build.lib`) builds ES / CommonJS / UMD / IIFE outputs with automatic externals, CSS extraction, `.d.ts` via Oxc isolated declarations (tsc fallback), package.json `exports` checks and `--watch`.
- **Build cache** (`.lunx/`): an unchanged project skips `lunx build` (~150 ms instead of ~700 ms on a 2,000-component app), and framework compiler output is cached per file (1,000 Vue SFCs: 3.5 s cold, 0.7 s warm). `--force`, `LUNX_BUILD_CACHE=0` or `build.cache: false` bypass it. `LUNX_TIMINGS=1` prints build phase timings.
- esbuild plugins from `optimizeDeps.esbuildOptions.plugins` run in the dependency optimizer.
- `npm run test:federation-e2e`; the browser matrix now clicks through every fixture (133/133).

### Changed
- Production builds no longer wait on the OSV vulnerability API: findings come from the cache and a background process refreshes it (strict projects still wait).
- Rollup's and vite-node's APIs, used by Nitro, React Router and Nuxt, are served by lunx's engine.
- `engines.node` is `^20.19.0 || >=22.12.0`, as Rolldown requires.

### Fixed
- Vue scoped-style ids are derived from the file path and source, so builds are reproducible.
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
