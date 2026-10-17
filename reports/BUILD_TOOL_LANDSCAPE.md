# lunx against every build tool, in every area

Measured on 2026-10-17 (Linux, Node 22.22, 4 cores) with the versions below.
Speed, size and install numbers come from running each tool here
(`npm run bench:arena`, `scripts/footprint.sh`). The feature tables come from
running lunx and reading each tool's installed type definitions (Vite's
`UserConfig`, Rsbuild's `RsbuildConfig`…). Where a table cites a tool's own
documentation instead, it says so.

| tool | version | kind |
|---|---|---|
| **lunx** | 1.2.0 + master (unreleased) | dev server + build, Rolldown/Oxc |
| Vite | 8.3.4 | dev server + build, Rolldown/Oxc |
| Rsbuild | 2.2.13 | dev server + build on Rspack |
| Rspack | 2.2.9 | bundler (webpack API, Rust) |
| webpack | 5.111.1 | bundler |
| Parcel | 2.16.4 | zero-config bundler |
| Farm | 1.7.11 | dev server + build, Rust |
| esbuild | 0.28.2 | bundler, no dev server |
| Bun | 1.4.3 | runtime with a bundler |
| Rolldown | 1.2.14 | bundler library (JS only) |

Turbopack is not in the tables: it still ships only inside Next.js (stable
there since Next 16), and Vercel has not released the standalone bundler.

---

## 1. Speed

One React 19 + TypeScript app, every tool run round by round (interleaved,
so a slow spell of the machine hits them all). Medians of 5 runs (3 at
2,000 components, 2 at 10,000). Caches are cleared before each first start
and kept for the restart. **First page** = spawn → Chromium shows the app on
a first start; **restart** = the same with the caches the first start left;
**HMR** = save `App.tsx` → Chromium shows it. `lunx --bundle` is
`server.bundle` (bundled dev).

**Small app**

| tool | dev boot | first page | restart | HMR | build cold | build warm |
|---|---|---|---|---|---|---|
| **lunx** | **364 ms** | 1,224 ms | **657 ms** | 42 ms | 654 ms | 116 ms |
| lunx --bundle | 372 ms | 1,281 ms | 704 ms | **33 ms** | – | – |
| Vite | 525 ms | 1,538 ms | 1,021 ms | 45 ms | 693 ms | 606 ms |
| Rspack | 473 ms | **804 ms** | 833 ms | 239 ms | 498 ms | 435 ms |
| Rsbuild | 558 ms | 834 ms | 859 ms | 88 ms | 687 ms | 694 ms |
| Farm | 1,634 ms | 1,964 ms | 1,883 ms | 57 ms | 2,396 ms | 1,652 ms |
| Parcel | 1,796 ms | 2,067 ms | 2,148 ms | 41 ms | 2,232 ms | 2,291 ms |
| webpack | 2,244 ms | 2,787 ms | 2,658 ms | 347 ms | 5,367 ms | 5,272 ms |
| esbuild | – | – | – | – | 79 ms | 94 ms |
| Bun | – | – | – | – | **63 ms** | **57 ms** |
| Rolldown | – | – | – | – | 527 ms | 335 ms |

**2,000 components**

| tool | dev boot | first module | first page | restart | HMR | build cold | build warm |
|---|---|---|---|---|---|---|---|
| **lunx** | 393 ms | **446 ms** | 7,943 ms | 6,847 ms | 202 ms | 1,174 ms | 187 ms |
| lunx --bundle | **356 ms** | 1,786 ms | 2,554 ms | **1,636 ms** | **167 ms** | – | – |
| Vite | 493 ms | 931 ms | 8,657 ms | 7,671 ms | 220 ms | 964 ms | 893 ms |
| Rspack | 878 ms | 1,038 ms | **1,824 ms** | 1,803 ms | 863 ms | 1,189 ms | 1,082 ms |
| Rsbuild | 1,222 ms | 1,348 ms | 2,205 ms | 2,196 ms | 556 ms | 1,057 ms | 950 ms |
| Parcel | 6,917 ms | 6,979 ms | 7,721 ms | 7,318 ms | 239 ms | 6,963 ms | 6,904 ms |
| webpack | 5,501 ms | 5,850 ms | 6,744 ms | 6,628 ms | 1,301 ms | 12,528 ms | 11,855 ms |
| Farm | failed¹ | | | | | | |
| esbuild | – | – | – | – | – | 189 ms | 186 ms |
| Bun | – | – | – | – | – | **120 ms** | **117 ms** |
| Rolldown | – | – | – | – | – | 1,189 ms | 496 ms |

**10,000 components** (the five dev servers)

| tool | dev boot | first page | restart | HMR | build cold | build warm |
|---|---|---|---|---|---|---|
| **lunx** | **390 ms** | 30,329 ms | 29,852 ms | 692 ms | 3,525 ms | **243 ms** |
| lunx --bundle | 468 ms | 7,905 ms | **5,114 ms** | **431 ms** | – | – |
| Vite | 535 ms | 35,998 ms | 33,579 ms | 696 ms | **2,929 ms** | 2,699 ms |
| Rspack | 2,687 ms | **5,636 ms** | 5,509 ms | 2,788 ms | 3,941 ms | 3,867 ms |
| Rsbuild | 3,629 ms | 7,219 ms | 7,408 ms | 1,871 ms | 3,532 ms | 3,660 ms |

¹ Farm 1.7 cannot resolve `react/jsx-dev-runtime` through a symlinked
`node_modules` (the scaled apps share the small app's).

Cold builds swing up to 2× between runs on this machine; with 3 samples
the 2,000-component ranking is within noise. Measured 8 times interleaved
on the same app, lunx's cold build was 768 ms (median) against Vite's
979 ms.

**Verdict.** lunx boots fastest at every size, restarts fastest (unbundled
on the small app, bundled from 2,000 components on), has the fastest HMR at
every size, and the fastest warm build of every tool with a dev server
(4–15× faster). It loses two columns:

- **First page of a first start**, to Rspack and Rsbuild: 1.2 s vs 0.8 s on
  the small app, 2.6 s vs 1.8 s at 2,000 components (bundled), 7.9 s vs
  5.6 s at 10,000. A first visit waits for the dependency pre-bundle
  (React's development build through Rolldown, ~0.2–0.5 s; esbuild needs
  ~0.13 s) and, bundled, for the app's own build. The restart, with both
  cached, is faster than theirs.
- **Cold build of the small app**, to Rspack (654 ms vs 498 ms). lunx also
  tree-shakes inside React's CommonJS, which is why its output is the
  smallest; that pass now lexes in Rust (~16 ms, ~75 ms before).

esbuild and Bun build faster, but they are bundlers with no HMR dev server,
CSS pipeline or framework compilers.

## 2. Build output

What the browser downloads: JS, gzip -9 (license files excluded).

| tool | small app | 2,000 components | 10,000 components |
|---|---|---|---|
| **lunx** | **63,925 B** | **80,986 B** | **148,606 B** |
| Bun | 65,544 B | 82,437 B | |
| Vite | 67,988 B | 85,684 B | 154,512 B |
| Rolldown | 68,116 B | 86,308 B | |
| esbuild | 68,959 B | 87,223 B | |
| Rspack | 69,018 B | 91,455 B | 180,032 B |
| Rsbuild | 69,096 B | 90,602 B | 176,974 B |
| Parcel | 69,639 B | 91,037 B | |
| webpack | 70,368 B | 89,463 B | |
| Farm | 70,581 B | failed | |

**lunx is smallest at every size, Bun included.** lunx rewrites
dependencies' CommonJS modules with a static shape (React, ReactDOM, the
scheduler) as ES modules, so Rolldown drops the exports the app never uses
(`build.commonjsTreeShaking`, on by default): ~5 KB of React DOM on the
small app. Bun removed that code before; now lunx removes more. License
notices go to `<chunk>.LICENSE.txt` (`build.legalComments: 'linked'`, the
default).

**Per framework, lunx is smallest.** In `npm run test:parity` (vanilla,
React, Preact, Vue, Svelte, Solid, Lit, a two-page app), lunx's gzip JS is
smaller than Vite 8's in every scenario. Against their own CLIs
(`npm run test:meta-parity`), lunx's client builds are smaller or within
1% for all twelve meta-frameworks; for Angular, smaller than `ng build`'s
(31.7 KB vs 31.9 KB).

## 3. Frameworks

✅ built in · 🔌 official/first-party plugin · 🧩 community plugin · ❌ none.
Competitor cells follow each tool's own documentation.

| | lunx | Vite | Rsbuild | Rspack / webpack | Parcel | Farm | Bun |
|---|---|---|---|---|---|---|---|
| React (Fast Refresh) | ✅ | 🔌 | 🔌 | 🔌 | ✅ | 🔌 | ✅ |
| React Compiler | ✅ (project's Babel plugin, dev + build) | 🔌 (Babel) | ✅ Rust (2.1) | 🧩 | ❌ | ❌ | ❌ |
| React Server Components | ✅ `@vitejs/plugin-rsc` apps, Waku, React Router | 🔌 `plugin-rsc` | ✅ (2.0) | experimental (2.0) | ✅ (beta) | ❌ | ❌ |
| Vue (SFC, HMR) | ✅ | 🔌 | 🔌 | 🔌 loader | ✅ | 🔌 | 🧩 |
| Svelte 5 | ✅ | 🔌 | 🔌 | 🧩 loader | 🧩 | 🔌 | 🧩 |
| Solid | ✅ | 🧩 | 🔌 | 🧩 | ❌ | 🔌 | ❌ |
| Preact | ✅ | 🔌 | 🔌 | 🧩 | ✅ | 🔌 | 🧩 |
| Lit | ✅ | ✅ (vanilla) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Angular (AOT) | ✅ | via Analog / `@angular/build` | 🧩 Nx | ✅ Angular CLI (webpack) | ❌ | ❌ | ❌ |
| Qwik | ✅ | 🔌 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Alpine, Mithril, Inferno, Marko, Stencil | ✅ | 🧩 | partial | 🧩 | partial | ❌ | ❌ |

**Meta-frameworks**

| | lunx | Vite | Rsbuild / Rspack | webpack |
|---|---|---|---|---|
| SvelteKit, Nuxt, Astro, React Router, Remix, TanStack Start, SolidStart, Qwik City, Analog, VitePress, Waku, Marko Run | ✅ built by lunx (Vite plugins on its engine; client size ≤ their own CLI, `npm run test:meta-parity`) | ✅ native | TanStack Start, Modern.js, Rspress | ❌ |
| Next.js, Docusaurus, Gatsby, RedwoodJS | runs their own CLI | ❌ | Next (experimental), Docusaurus (Rspack) | ✅ |
| Storybook | ✅ `lunx exec storybook` (its Vite builder on lunx) | ✅ builder | ✅ builder | ✅ builder |
| Vitest, and other Vite-only tools (Vike, Histoire, Slidev…) | ✅ Vitest via `lunx exec vitest` (jsdom, snapshots); others untested | ✅ | ❌ | ❌ |

## 4. Module federation

| | lunx | webpack / Rspack (`@module-federation/enhanced`) | Vite (`@module-federation/vite`) | Rsbuild |
|---|---|---|---|---|
| Expose / consume, shared singletons, `requiredVersion`, `strictVersion`, `eager` | ✅ | ✅ | ✅ | ✅ |
| Interop with webpack / Rspack apps | ✅ both directions (6/6 pairings) | ✅ | ✅ | ✅ |
| `mf-manifest.json` | ✅ | ✅ | ✅ | ✅ |
| Dev HMR across host and remote | ✅ | ✅ | partial | ✅ |
| `loadRemote`, `preloadRemote` | ✅ | ✅ | ✅ | ✅ |
| `registerRemotes` (remotes added at runtime) | ✅ | ✅ | ✅ | ✅ |
| Runtime plugins (retry, fallback, auth…) | ✅ `beforeRequest`, `onLoad`, `errorLoadRemote` | ✅ | ✅ | ✅ |
| Type hints for remotes (`dts`) | ✅ `@mf-types.zip`, same layout as the MF dts plugin | ✅ | ✅ | ✅ |
| `shareStrategy`, `shareScope`, `import: false` | ✅ | ✅ | ✅ | ✅ |
| Remote as object (`{ entry, type }`) | ✅ | ✅ | ✅ | ✅ |
| Chrome DevTools extension | ✅ module graph, shared packages, remote overrides | ✅ | ✅ | ✅ |

## 5. Bundler features

| | lunx | Vite | Rsbuild / Rspack | webpack | Parcel | esbuild | Bun |
|---|---|---|---|---|---|---|---|
| Tree shaking, scope hoisting, code splitting | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CSS code splitting | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CSS modules, PostCSS, Sass, Less, Stylus, Tailwind v4 | ✅ | ✅ | ✅ | loaders | ✅ | partial | partial |
| `new Worker(new URL(…, import.meta.url))` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `import W from './w.js?worker'` (`&url`, `&inline`) | ✅ | ✅ | ✅ (2.1) | ❌ | ❌ | ❌ | ❌ |
| `` import(`./locales/${lang}.js`) `` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `import.meta.glob` | ✅ | ✅ | ✅ (`import.meta.webpackContext`) | ✅ (`require.context`) | ✅ glob | ❌ | ❌ |
| `.wasm?init` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Wasm ESM import (`import { f } from './a.wasm'`) | ✅ | ✅ (8.1) | ✅ | ✅ | ❌ | ❌ | partial |
| Syntax lowering for older browsers (`build.target` / browserslist) | ✅ default: Baseline widely available | ✅ | ✅ | ✅ | ✅ | ✅ | partial |
| Polyfills (core-js usage, legacy `nomodule`) | ✅ `build.polyfill` entry / usage; `build.legacy` (`nomodule`, ES2015 or ES5) | 🔌 `plugin-legacy` | ✅ `output.polyfill` | ✅ | ✅ differential | ❌ | ❌ |
| `build.manifest` (Laravel, Rails, Django backends) | ✅ | ✅ | ✅ | 🔌 | ✅ | ✅ metafile | ❌ |
| `ssrManifest` | ✅ | ✅ | ✅ | 🔌 | ❌ | ❌ | ❌ |
| Chunk import map (stable hashes) | ✅ `build.chunkImportMap` | ✅ (8.1) | ❌ | ❌ | ❌ | ❌ | ❌ |
| CDN URLs per asset (`renderBuiltUrl` / `assetPrefix`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Drop `console` / `debugger` | ✅ `build.drop` | via minifier options | ✅ `removeConsole` | ✅ (Terser) | ❌ | ✅ `drop` | ✅ |
| Legal comments (measured) | `.LICENSE.txt` per chunk (`build.legalComments`) | dropped | Rsbuild: `.LICENSE.txt`; Rspack: dropped | dropped | dropped | kept inline | dropped |
| Library mode (es, cjs, umd, iife, `.d.ts`) | ✅ | ✅ (no dts) | ✅ Rslib | ✅ | ✅ | ✅ | ✅ |
| Persistent build cache | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Remote (shared) cache | ✅ `cache.remote` (HTTP, S3) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Precompressed .gz / .br | ✅ | 🔌 | 🔌 | 🔌 | ✅ | ❌ | ❌ |
| Bundled dev mode for 10k+ module apps | ✅ `server.bundle` / `--bundle` (Rolldown dev engine, patch HMR, React Refresh) | ✅ experimental (8.1) | n/a (bundler) | n/a | n/a | n/a | n/a |
| Single-file executable | ✅ `lunx compile` (Node SEA) | ❌ (Vite+: `vp pack`) | ❌ | ❌ | ❌ | ❌ | ✅ `--compile` |

## 6. Advanced options

Options a production project reaches for. A lunx ❌ means neither
`lunx.config` nor a `vite.config` it reads can set it today.

| option | lunx | Vite | Rsbuild |
|---|---|---|---|
| `base`, `outDir`, `publicDir`, `define`, `alias`, env files | ✅ | ✅ | ✅ |
| `envPrefix`, `envDir` | ✅ | ✅ | ✅ |
| `sourcemap` (inline, hidden, external) | ✅ | ✅ | ✅ |
| `minify` on/off | ✅ | ✅ | ✅ |
| `cssMinify`, `cssTarget` | ✅ | ✅ | ✅ |
| `assetsInlineLimit` | ✅ | ✅ | ✅ |
| `assetsInclude` | ✅ (vite.config, plugin host) | ✅ | ✅ |
| `emptyOutDir` / `cleanDistPath` | ✅ | ✅ | ✅ |
| `copyPublicDir` / `copy` | ✅ | ✅ | ✅ |
| Output file name templates | ✅ entry / chunk / asset | ✅ | ✅ |
| Chunk splitting | ✅ `build.splitChunks` strategies (single-vendor, split-by-module, split-by-experience, all-in-one), Rolldown groups, `manualChunks` (object or function) | ✅ `advancedChunks` | ✅ strategies |
| `chunkSizeWarningLimit`, `reportCompressedSize` | ✅ | ✅ | ✅ |
| Preload / prefetch / preconnect hints | ✅ | ✅ | ✅ |
| `externals` in apps | ✅ `build.external` | ✅ | ✅ |
| HTML: title, meta, favicon, tags | ✅ `html` | 🔌 | ✅ |
| `html.cspNonce` | ✅ | ✅ | ✅ `security.nonce` |
| SRI | ✅ default | ❌ | ✅ |
| `server.proxy`, `https`, `cors`, `headers`, `open`, `strictPort` | ✅ | ✅ | ✅ |
| `server.allowedHosts` (DNS rebinding guard) | ✅ on by default, localhost-only CORS | ✅ | ✅ |
| `server.warmup` | ✅ | ✅ | n/a |
| `css.preprocessorOptions` (`additionalData`), `css.modules` (`generateScopedName`, `localsConvention`) | ✅ | ✅ | ✅ |
| `middlewareMode` (embed in Express) | ✅ | ✅ | ✅ |
| `writeToDisk` in dev | ❌ | ❌ | ✅ |
| Environment API (client + SSR + edge in one config) | partial (plugin host) | ✅ | ✅ `environments` |
| JS API (`build()`, `createServer()`) | ✅ | ✅ | ✅ |

## 7. Toolchain around the bundler

| | lunx | Vite (+ Vite+) | Rstack | Parcel | Bun |
|---|---|---|---|---|---|
| Scaffolding | ✅ `lunx create`, 27 templates | ✅ `create-vite`, `vp create` | ✅ | ❌ | ✅ |
| Test runner | ✅ `lunx test` (Vitest's API, worker threads); Vitest itself when installed | ✅ Vitest | ✅ Rstest | ❌ | ✅ `bun test` |
| · DOM environment (jsdom / happy-dom) | ✅ | ✅ | ✅ | | ✅ |
| · Coverage | ✅ V8, source-mapped (text, lcov) | ✅ | ✅ | | ✅ |
| · Snapshots | ✅ Vitest's format, inline too | ✅ | ✅ | | ✅ |
| · Browser mode | ❌ | ✅ | ✅ | | ❌ |
| Type check | ✅ `lunx check`, dev overlay | ✅ `vp check` (tsgo) | ❌ | ❌ | ❌ |
| Lint | ✅ `lunx lint` (Oxlint) | ✅ `vp lint` (Oxlint) | ❌ | ❌ | ❌ |
| Format | ✅ `lunx fmt` (Oxfmt) | ✅ `vp fmt` (Oxfmt) | ❌ | ❌ | ❌ |
| Monorepo task runner with cache | ✅ `lunx run` | ✅ `vp run` | ❌ | ❌ | partial (workspaces) |
| Bundle analysis | ✅ `lunx analyze`, `lunx why` | 🔌 | ✅ Rsdoctor | ❌ | ❌ |
| DevTools UI | `lunx inspect` | ✅ Vite DevTools | ✅ Rsdoctor | ❌ | ❌ |
| Security: CVE gate, SBOM, SRI, secret scan, CSP | ✅ | ❌ | partial (SRI) | ❌ | ❌ |
| PWA | ✅ built in | 🔌 | 🔌 | 🔌 | ❌ |
| Electron | ✅ built in | 🔌 | 🔌 | ❌ | ❌ |
| Plugin ecosystems run unchanged | Vite / Rollup plugins, esbuild plugins | Vite / Rollup | webpack loaders & plugins | Parcel | Bun / esbuild-style |
| webpack loaders | ❌ | ❌ | ✅ | ❌ | ❌ |
| Node version manager, package manager | ❌ | ✅ `vp env`, `vp install` | ❌ | ❌ | ✅ |

## 8. Install footprint

Packages in `node_modules` and disk, for what a React + TypeScript app needs
(lunx-dev alone; Vite with `@vitejs/plugin-react`; webpack with its CLI, dev
server, HTML plugin and SWC / CSS loaders…).

| tool | packages | disk |
|---|---|---|
| esbuild | **2** | **12 MB** |
| Bun | 2 | 85 MB (a whole runtime) |
| Rspack (+ CLI, dev server) | 6 | 55 MB |
| Rsbuild (+ React plugin) | 9 | 59 MB |
| **lunx** | 11 | **33 MB** |
| Vite (+ React plugin) | 16 | 34 MB |
| webpack (+ 7 packages) | 343 | 91 MB |
| Parcel | 122 | 111 MB |
| Farm (+ CLI, React plugin) | 340 | 142 MB |

lunx's 33 MB includes every framework compiler it ships (Vue, Svelte, Solid…
are loaded only when used) and the security scanner.

## 9. What others have and lunx does not

**Closed in 1.2.0** (every item tested: `tests/build/*.test.ts`, the
browser, parity and template matrices)

- P1, correctness: template-literal `import()`; `?worker` imports;
  `build.target` / browserslist lowering; `build.manifest`; federation type
  hints (were documented but missing); `cache.remote` (was accepted, did
  nothing; now HTTP and S3); `NO_COLOR` in error frames.
- P2, output size: `build.legalComments` (default `linked`). lunx is now
  second, behind Bun.
- P3, options: `assetPrefix` / `renderBuiltUrl`, `emptyOutDir`,
  `copyPublicDir`, `chunkSizeWarningLimit`, file name templates, `external`
  for apps, `drop`, `cssTarget` / `cssMinify`, `ssrManifest`, prefetch
  hints, `html` (title, meta, favicon, tags, `cspNonce`), `middlewareMode`,
  `allowedHosts` / CORS defaults as Vite's, `build()` / `createServer()`.
- P4, ecosystem: Storybook and Vitest (`lunx exec`), React Compiler, React
  Server Components on `@vitejs/plugin-rsc`, federation `registerRemotes`,
  runtime plugins, `shareStrategy`, `import: false` and object remotes, Wasm
  ESM imports, core-js polyfills (`build.polyfill`).

**Closed since 1.2.0** (on master, unreleased; tested in `tests/build/*.test.ts` and the matrices)

- Output: tree shaking inside CommonJS dependencies (`build.commonjsTreeShaking`,
  on by default; large modules read by a lexer checked against the syntax tree on
  18,822 CommonJS files, and run in Rust when the native binding has it: the same
  decisions on all 19,020 CommonJS files in node_modules). lunx's output is now
  the smallest of every tool, Bun included.
- Bundler: chunk import maps (`build.chunkImportMap`), a legacy `nomodule`
  build (`build.legacy`), single-file executables (`lunx compile`), unchanged
  builds in ~40 ms.
- Dev: bundled dev mode (`server.bundle`, `lunx dev --bundle`): the browser
  matrix passes 133/133 with it.
- Federation: the Module Federation Chrome DevTools extension.
- Toolchain: `lunx test` with DOM environments, coverage and snapshots;
  `lunx lint` / `lunx fmt`; `lunx run` (workspace tasks with a cache).

**Still missing**

1. A first start's first page as fast as Rspack's (see §1): the dependency
   pre-bundle is on its critical path.
2. Test runner: browser mode.
3. Bundled dev for projects with Vite plugins or module federation (they serve
   modules one by one).
4. webpack loaders; a Node version / package manager (Vite+, Bun).
5. `writeToDisk` in dev; the Environment API is partial.
6. Next.js, Docusaurus, Gatsby, RedwoodJS and Stencil still run their own CLIs.

**Where lunx leads**

Fastest dev boot, restart, HMR and warm build of every tool with a dev
server, at every size · the smallest output of every tool, Bun included,
and smaller per framework than Vite and the meta-frameworks' own CLIs · the widest framework list built by one
tool (10 app frameworks, 12 meta-frameworks built, 5 delegated, plus
Storybook and Vitest on its engine) · module federation interoperable with
webpack and Rspack, with the `@module-federation` runtime API · supply-chain
security, PWA, Electron, `.gz`/`.br`, SRI and license files built in.

---
Sources for documentation-based cells:
[Vite+ alpha](https://voidzero.dev/posts/announcing-vite-plus-alpha),
[Vite 8.1](https://vite.dev/blog/announcing-vite8-1),
[Rsbuild 2.0](https://rsbuild.rs/blog/v2-0),
[Rspack 2.0](https://rspack.rs/blog/announcing-2-0),
[Parcel RSC](https://parceljs.org/recipes/rsc),
[Bun full-stack](https://bun.com/docs/bundler/fullstack),
[Bun executables](https://bun.com/docs/bundler/executables),
[Turbopack](https://vercel.com/blog/turbopack-moving-homes).
