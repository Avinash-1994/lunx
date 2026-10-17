# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Bundled dev mode**: `server: { bundle: true }` (or `lunx dev --bundle`, or a vite.config's `experimental.bundledDev`) serves the page as bundles from Rolldown's dev engine instead of one request per module, as Rspack and Vite 8.1's full-bundle mode do. Saves arrive as patches of the changed modules over the HMR socket, applied by a runtime with `import.meta.hot` (accept, dispose, invalidate, dependency accepts) and React Fast Refresh that keeps component state. Packages stay out of the bundles (a native external, so no JS hook runs per import) and load pre-bundled beside them, built once and cached across restarts. React, Preact and plain TS/JSX compile in Rolldown; Vue, Svelte, Solid, Angular (templates in their own files included) and the rest go through lunx's compilers. At 2,000 components the first visit renders in 2.6 s (Rspack 1.8 s, Rsbuild 2.2 s, Vite and unbundled lunx ~8 s), a restart in 1.6 s (the fastest), with the fastest HMR of all (167 ms; Rspack 863 ms). The browser matrix passes 133/133 with it (`npm run test:browser-matrix -- --bundle`). Projects with Vite plugins, module federation or SSR keep serving modules one by one.
- **Module Federation DevTools** (the Chrome extension): lunx's federation runtime keeps `globalThis.__FEDERATION__` (alias `__VMOK__`) as `@module-federation/runtime` does: the module graph in `moduleInfo`, the share scope in `__SHARE__`, and the plugins in `__GLOBAL_PLUGIN__` run as its own (`beforeRegisterRemote`, `beforeLoadRemoteSnapshot`, `loadRemoteSnapshot`, `beforeRequest`, `onLoad`, `errorLoadRemote`), so the extension shows the app's remotes and shared packages and its remote overrides point a remote at a local build.
- **Tree shaking inside CommonJS dependencies** (`build.commonjsTreeShaking`, on by default): static CommonJS modules (React, ReactDOM, scheduler…) become ES modules before bundling, so Rolldown drops the parts the app never reaches. lunx's output is now the smallest of every tool measured, Bun included.
- `build.chunkImportMap`: chunks import each other through an inline import map (Rolldown's `chunkImportMap`, Vite 8.1's), so a change to one chunk keeps every other chunk's file name and cache.
- `build.legacy` (`true` or `{ targets, babel }`): a `nomodule` script beside each module entry for browsers without ES modules, ES2015 by Oxc or ES5 by the project's Babel preset-env, with core-js polyfills and the Safari 10.1 fix, as `@vitejs/plugin-legacy`.
- `lunx compile <entry>`: a single-file executable of a Node program (Node's single executable applications), as `bun build --compile`.
- `lunx lint` and `lunx fmt`: Oxlint and Oxfmt, as `vp lint` / `vp fmt`.
- `lunx run <script>`: a package.json script across a monorepo's workspaces (package.json `workspaces` or pnpm-workspace.yaml), dependencies first, independent packages in parallel, with a local cache that restores outputs and replays logs (`--filter`, `--concurrency`, `--no-cache`), as Turborepo and `vp run`.
- **`lunx test`, rewritten**: test files run in worker threads with Vitest's API (`describe`/`it`/`test` with `skip`/`only`/`todo`/`each`, hooks, `expect` with Jest's matchers, asymmetric matchers, `resolves`/`rejects`, `vi.fn`/`spyOn`, fake timers, `vi.stubGlobal`, `waitFor`), DOM environments (jsdom, happy-dom: `// @vitest-environment`), snapshots in Vitest's format (`toMatchSnapshot`, `toMatchInlineSnapshot`, `-u`, `--ci`), V8 coverage mapped through source maps (`--coverage`: text, lcov), `-t` filters and `--watch`. A project with Vitest installed keeps running Vitest (`--builtin` uses lunx's).

### Performance
- An unchanged `lunx build` answers in ~40 ms (Bun 46 ms, esbuild 65 ms): a CommonJS entry checks the inputs' stamps without loading the CLI, and a removed output directory is restored from the last build's snapshot.
- `lunx dev` serves a module it has served before, unchanged since, from memory with an ETag (304 on revisits): a second visit to a 2,000-component app loads in 3.0 s instead of 4.9 s.

## [1.2.0] - 2026-10-15

### Added
- `` import(`./locales/${lang}.js`) `` is bundled: every file the pattern matches becomes a lazy chunk, aliases included (the import was left as-is and failed with a 404).
- `import MyWorker from './worker.js?worker'` (and `?sharedworker`, `&url`, `&inline`), as in Vite, in dev and builds (the build failed).
- `build.target` / `build.cssTarget` (also read from a vite.config), or the project's browserslist: Oxc lowers JS syntax and LightningCSS lowers and prefixes CSS for those browsers. The default is Vite's `baseline-widely-available` (CSS nesting is lowered for Safari 16). `build.targets` was accepted before but not used.
- `build.legalComments: 'linked' | 'inline' | 'none'`. The default, `linked`, moves third-party license notices out of the shipped JS into `<chunk>.LICENSE.txt` beside each chunk, linked from its last line (as Rsbuild and webpack do). React apps ship ~280 B less gzip; lunx's JS is now smaller than Vite's, Rsbuild's, Rspack's, esbuild's, Parcel's and webpack's on the benchmark app (only Bun's is smaller).
- Build options production projects expect, also read from a vite.config where Vite has them: `build.assetPrefix` / `renderBuiltUrl` (built files from a CDN), `entryFileNames` / `chunkFileNames` / `assetFileNames` templates, `external`, `drop: ['console', 'debugger']`, `cssMinify`, `emptyOutDir`, `copyPublicDir`, `chunkSizeWarningLimit` (a warning above 500 kB, as Vite), `prefetch` (`<link rel="prefetch">` for lazy chunks) and `ssrManifest`.
- `html` in lunx.config, in dev and builds: `title`, `meta`, `favicon`, `preconnect`, `dnsPrefetch`, `tags` and `cspNonce` (on every script and stylesheet, lunx's own included, as Vite's `html.cspNonce`).
- JavaScript API: `build()` and `createServer()`, and `server.middlewareMode` to run the dev server inside your own (Express, Fastify, http) with HMR on its socket.
- `import { add } from './add.wasm'`: WebAssembly ESM integration (as Vite 8.1), in dev and builds. The module's exports are named exports, its imports come from the JS modules its import section names. `?init` and `?url` stay as they were; an installed `vite-plugin-wasm` keeps the job.
- Module federation runtime, as `@module-federation/runtime`'s (and importable under that name, so code written for webpack / Rspack federation runs unchanged): `registerRemotes` (remotes added at run time, `force` to replace one), runtime plugins (`federation.runtimePlugins`, or `registerPlugins`: `beforeRequest`, `onLoad`, `errorLoadRemote` for fallbacks), `shareStrategy: 'version-first'`, shared `import: false`, and remotes as `{ entry, name, type }`.
- The React Compiler (its `react/compiler-runtime` pre-bundled in dev): with `babel-plugin-react-compiler` installed, lunx runs it on the app's components and hooks in dev and builds (`react: { compiler: false }` turns it off, an object passes its options). Left to `@vitejs/plugin-react` when a vite.config uses it.
- **`lunx exec <tool>`: Vite-based tools on lunx's engine.** Storybook (`lunx exec storybook dev` / `build`, React + Vite framework, stories render in Chromium) and Vitest 5 (`lunx exec vitest run`: node and jsdom tests, snapshots) run with `vite` pointing at lunx: no Vite or Rollup code runs. The plugin host gained what they use: Vite's `fetchModule`, `pluginContainer.getModuleInfo`, `dev.moduleRunnerTransform`, `assetsInclude` functions, `optimizeDeps.entries` crawled through their imports (glob-escaped paths included), and page scripts a plugin serves (`virtual:/…`).
- **React Server Components without a framework**: a project on `@vitejs/plugin-rsc` (its rsc / ssr / client environments) runs `lunx dev` / `lunx build` / `lunx preview` on lunx's engine, server components rendered and client components hydrated (checked in Chromium). The dependency optimizer now pre-bundles an `optimizeDeps.include` subpath of an excluded package (as Vite), and reads export names through React's `module.exports = require('./cjs/…')` files when a module cannot be evaluated in Node.
- `build.polyfill: 'entry' | 'usage'` (Rsbuild's): core-js polyfills for the build's targets, all of them first in each entry or only those the code uses (from the project's `core-js`, with `core-js-compat`, or `@babel/core` + `babel-plugin-polyfill-corejs3` for usage).
- `build.manifest` writes `.vite/manifest.json` in Vite's format (entries, imports, dynamic imports, CSS, assets) for server-rendered backends.
- Module federation types, in `@module-federation`'s `@mf-types` format: remotes write and serve `@mf-types.zip`, hosts download them into `@mf-types/<remote>/`. The docs described a `federation.dts` option that did not exist.
- `cache.remote` shares compile results between machines: `provider: 'http'` (GET/PUT, bearer token) or `'s3'` (SigV4, AWS credentials from the environment), `readOnly` for pull requests. It was accepted before and did nothing; `'lunx-cloud'` (never a real service) is now an error.
- **CSS code splitting**, as in Vite: CSS that only lazy chunks import goes in their own stylesheets, and a lazy chunk's `import()` resolves once its CSS has loaded (no flash of unstyled content); the page's stylesheet keeps what loads up front. `build.cssCodeSplit: false` (also read from a vite.config) keeps one file.
- **Build output audit** (`npm run test:parity`): the same app per framework (vanilla, React, Preact, Vue, Svelte, Solid, Lit, and a two-page React app with lazy routes, base path and source maps) built by lunx and Vite 8, both run in Chromium, outputs compared. lunx's JS is smaller in every one; every probe passes.
- **Module federation with webpack 5 and Rspack** (`npm run test:mf-interop`): lunx hosts with webpack / Rspack remotes, webpack / Rspack hosts with lunx remotes, and shells mixing all three, in Chromium with React shared as a singleton.
- **Built in, no plugin needed**: SVG files as components (`import Logo from './logo.svg?react'` for React and Preact, `?component` for the app's framework, Vue included), in place of `vite-plugin-svgr` / `vite-svg-loader`; `.wasm?init` imports, as in Vite; `%ENV%` values in `index.html` (`%VITE_APP_TITLE%`, `%MODE%`…), as in Vite. An installed `vite-plugin-svgr` keeps `?react`. Checked in Chromium by the plugin matrix (`builtin-*` scenarios).
- **PWA, built in**: `pwa: { manifest }` in lunx.config writes `manifest.webmanifest`, `registerSW.js` and a `sw.js` that precaches the finished build (after SRI), serves it cache-first, falls back to `index.html` for offline navigations and drops old caches on deploy. No Workbox. The plugin matrix checks it offline in Chromium. An installed `vite-plugin-pwa` keeps the job.
- **Type errors in dev, built in**: `server: { typecheck: true }` runs the project's `tsc` (or `vue-tsc`) in watch mode beside `lunx dev`; each pass's errors go to the terminal and to a Type Errors tab in the overlay, and clear once fixed. In place of `vite-plugin-checker`.
- Build errors print without colour codes under `NO_COLOR` or when stderr is not a terminal (Rolldown's code frames kept theirs).
- The error overlay shows compiler messages as text (`Promise<string>` was parsed as markup) and links build errors to their file.
- `electron` and `pwa` are accepted in lunx.config (the config check rejected `electron` as an unknown key).
- `lunx-dev/client` types: assets, `?raw` / `?url` / `?inline` / `?react` / `.wasm?init`, CSS modules, `import.meta.env`, `import.meta.hot`, `import.meta.glob`. TypeScript app starters reference them in `src/lunx-env.d.ts`.
- **Electron, built in**: in a project with `electron` installed, lunx builds `electron/main.*` and `electron/preload.*` with Rolldown into `dist-electron/` (the main process as the package's module type with `dependencies` external; the preload as one CommonJS file for sandboxed renderers), alongside the renderer, which gets `base: './'`. `lunx dev` starts Electron on the dev server (`LUNX_DEV_SERVER_URL`), restarts it when the main process changes and reloads the window when the preload does; `lunx preview` runs the build in Electron. `electron: { main, preload, outDir }` or `false` in lunx.config; `LUNX_ELECTRON_ARGS` for Electron switches. `lunx create --template electron` (React renderer, main process, preload) uses it; the template matrix checks it in Electron. The old Electron adapter's process spawning (broken under ESM) is gone.
- `vite-plugin-electron` projects run on lunx unchanged: `build.lib`, `build.watch` and `platform` in the plugin host's `build()`, `closeBundle` after each watch rebuild, the dev server's `listening` event for plugins, a plugin's `config`-hook `base`, and relative `base: './'` (it was rewritten to `/./`).
- **Vite plugins in apps**, with Vite's lifecycle on lunx's own build and dev server (they used to reach the build as bare Rollup plugins, and dev ignored them): `apply`, `enforce`, `config`, `configResolved`, virtual modules, `transformIndexHtml`, stylesheet transforms around lunx's CSS compiler, `configureServer`, `writeBundle` / `closeBundle` once the app is on disk, Vite's asset placeholders, and HMR for modules a plugin built from other files (Tailwind). `scripts/vite-plugins-matrix.mjs` checks 17 popular plugins in Chromium.

### Changed
- **Dev server access, as Vite since CVE-2025-24010**: requests whose Host header names another domain get a 403 (DNS rebinding), and only pages on localhost may read responses cross-origin (it sent `Access-Control-Allow-Origin: *` to every site). `server.allowedHosts` and `server.cors` open it up.
- **Angular builds are ahead of time** when `@angular/compiler-cli` is installed (the Angular starter now has it): the project's Angular compiler (ngtsc) compiles the app, Angular's linker finishes partially compiled libraries, and Angular's build optimizations (pure top-level calls, static members in pure IIFEs, metadata and enum adjustments) run on Angular packages, with `ngDevMode` / `ngJitMode` defined `false`. The runtime template compiler (`@angular/compiler`) is no longer shipped: the starter went from 281 kB to 31.7 kB of gzip JS (`ng build`: 31.9 kB), built in 3.8 s cold (`ng build`: 4.9 s). Component styles in SCSS / Less / Stylus, lazy components and source maps work as before. Without the package, the build stays JIT and says so.
- Meta-framework builds (SvelteKit, Nuxt, Qwik City… on the plugin host) honour package.json `sideEffects`, as Vite does: the plugin host's resolver now reports it, and Rolldown kept every module a plugin resolved without it. Nuxt's client went from 23% larger than `nuxt build`'s to the same size (h3 had pulled node-mock-http and iron-webcrypto in), Qwik City's from 33% larger to smaller. `npm run test:meta-parity` compares all twelve with their own CLI.
- Vue and Svelte component CSS goes to the app's stylesheet in a build (it was injected from JavaScript: a flash of unstyled content, and blocked by a strict CSP), and to `style.css` in library builds.
- Vue `<style lang="scss" | "sass" | "less" | "stylus">` and `<style src>` are compiled (they reached the browser as-is), and `<style module>` gives `$style` / named modules. Svelte `<style lang="scss" | "less" | "stylus">` is compiled too.
- A Vue or Svelte compile error fails the build with the compiler's message, position and code frame (the uncompiled source used to reach the bundler, which reported a JavaScript syntax error in it), and source errors are no longer labelled "unexpected error, please report it".
- A lunx remote's modules carry `__esModule`, so webpack and Rspack hosts read their default export (React.lazy received the whole module before).
- A `lunx.config` next to a `vite.config` no longer hides it: the Vite config applies underneath (settings and plugins), `lunx.config` wins where both set something, and a plugin listed in both runs once. Adding a `lunx.config` for `pwa` or `electron` used to drop the Vite plugins.
- `lunx dev` prints its `ready in … ms` line again: the dev server silenced `console.log` while it loaded `.env` files, which since the server starts during the banner swallowed the line (tools waiting for it timed out).
- `server.writeToDisk` (`true`, or a function of the file path), as Rsbuild's `dev.writeToDisk`: what the dev server serves is written to outDir at its URL path, the page and everything it loads requested at start and again after each save. With `server.bundle`, the folder served statically is the whole app (page, bundles, pre-bundled packages, assets, `public/`).
- `envPrefix` and `envDir` (lunx.config, or a vite.config's): the prefixes client code sees and where the `.env` files live; an empty prefix is refused, as Vite does.
- `build.splitChunks`: Rsbuild's strategies (`single-vendor`, `split-by-module`, `split-by-experience`, `all-in-one`) or Rolldown's `advancedChunks` groups; a vite.config's `manualChunks` function and `advancedChunks` are read too (the object form already was).
- `build.reportCompressedSize: false`, `server.warmup.clientFiles` (compiled once the pre-bundle is done) without a vite.config, and `css.preprocessorOptions` (`additionalData` and the Sass / Less / Stylus options) and `css.modules` (`generateScopedName`, `localsConvention`) in lunx.config and vite.config.
- Faster production builds of React apps: the CommonJS → ESM pass that tree-shakes inside React (the smallest output) lexes in Rust when the native binding has it (`native/src/cjs_lexer.rs`, the same decisions as the JS lexer on all 19,020 CommonJS files in node_modules, `LUNX_NATIVE_LEXER=0` keeps it in JS), small modules included: ~16 ms per build instead of ~75 ms, the output byte for byte the same.
- Faster dev start of big apps: the dependency scan reads the sources synchronously, a slice at a time (2,000 files in ~0.1 s, ~0.75 s before), and module requests and bundles wait on it.
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
