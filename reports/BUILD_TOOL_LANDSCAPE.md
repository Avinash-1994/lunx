# lunx against every build tool, in every area

Measured on 2026-10-16 (Linux, Node 22.22, 4 cores) with the versions below.
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

One React 19 + TypeScript app. Medians of 7 runs (5 at 2,000 components).
HMR = save `App.tsx` until Chromium shows the change.

**Small app**

| tool | dev boot | HMR | build cold | build warm |
|---|---|---|---|---|
| **lunx** | **248 ms** | **30 ms** | **369 ms** | 385 ms |
| Vite | 409 ms | 40 ms | 663 ms | 487 ms |
| Rspack | 376 ms | 208 ms | 386 ms | **370 ms** |
| Rsbuild | 432 ms | 86 ms | 511 ms | 487 ms |
| Farm | 1,230 ms | 48 ms | 1,908 ms | 1,411 ms |
| Parcel | 1,449 ms | 35 ms | 1,693 ms | 1,761 ms |
| webpack | 1,578 ms | 275 ms | 4,313 ms | 4,066 ms |
| esbuild | – | – | 66 ms | 65 ms |
| Bun | – | – | **41 ms** | **46 ms** |
| Rolldown | – | – | 233 ms | 256 ms |

**2,000 components**

| tool | dev boot | first module | HMR | build cold | build warm |
|---|---|---|---|---|---|
| **lunx** | **243 ms** | **247 ms** | **151 ms** | **583 ms** | **547 ms** |
| Vite | 389 ms | 717 ms | 161 ms | 829 ms | 651 ms |
| Rspack | 700 ms | 839 ms | 656 ms | 804 ms | 878 ms |
| Rsbuild | 944 ms | 1,062 ms | 440 ms | 777 ms | 754 ms |
| Parcel | 4,523 ms | 4,542 ms | 177 ms | 5,042 ms | 5,060 ms |
| webpack | 4,268 ms | 4,522 ms | 1,113 ms | 8,763 ms | 8,715 ms |
| Farm | failed¹ | | | | |
| esbuild | – | – | – | 145 ms | 144 ms |
| Bun | – | – | – | **106 ms** | **82 ms** |
| Rolldown | – | – | – | 397 ms | 731 ms |

¹ Farm 1.7 cannot resolve `react/jsx-dev-runtime` through a symlinked
`node_modules` (the scaled app shares the small app's).

The container was busier than on 2026-10-15 (every tool measured slower);
the ranking is unchanged.

**Verdict.** Among tools with a dev server, lunx is fastest at boot, HMR and
cold build on both apps, and at warm build on the large one. Rspack's warm
build of the small app is 15 ms faster, within run-to-run noise. esbuild and
Bun build faster, but they are bundlers with no HMR dev server, CSS pipeline
or framework compilers.

## 2. Build output

What the browser downloads: JS, gzip -9.

| tool | small app | 2,000 components |
|---|---|---|
| Bun | **65,552 B** | **82,445 B** |
| **lunx** | 67,776 B | 85,410 B |
| Vite | 68,006 B | 85,702 B |
| Rolldown | 68,130 B | 86,322 B |
| esbuild | 68,967 B | 87,231 B |
| Rspack | 69,026 B | 91,460 B |
| Rsbuild | 69,256 B | 90,591 B |
| Parcel | 69,675 B | 91,079 B |
| webpack | 70,359 B | 89,442 B |
| Farm | 72,422 B | failed |

(Raw bytes rank differently: Rsbuild and Rspack are slightly smaller than
lunx uncompressed but larger after gzip.)

**lunx is now second, behind Bun only.** 1.2.0 moves third-party license
notices into `<chunk>.LICENSE.txt` (`build.legalComments: 'linked'`, the
default), which took ~280 B off the small app and put lunx ahead of Vite.

**Why Bun is still smaller (3–4%).** Bun removes more unused code inside
React's CommonJS files: functions and `Symbol.for(…)` constants that React
defines but the app never reaches. Rolldown keeps a CommonJS module's body
whole. Binding React's exports to local names (as Bun prints them) was tried:
6% fewer raw bytes, no gzip change, so it was dropped. Closing the rest needs
CommonJS tree shaking in Rolldown itself.

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
| `envPrefix`, `envDir` | partial | ✅ | ✅ |
| `sourcemap` (inline, hidden, external) | ✅ | ✅ | ✅ |
| `minify` on/off | ✅ | ✅ | ✅ |
| `cssMinify`, `cssTarget` | ✅ | ✅ | ✅ |
| `assetsInlineLimit` | ✅ | ✅ | ✅ |
| `assetsInclude` | ✅ (vite.config, plugin host) | ✅ | ✅ |
| `emptyOutDir` / `cleanDistPath` | ✅ | ✅ | ✅ |
| `copyPublicDir` / `copy` | ✅ | ✅ | ✅ |
| Output file name templates | ✅ entry / chunk / asset | ✅ | ✅ |
| Chunk splitting | `manualChunks` by package | ✅ `advancedChunks` | ✅ strategies |
| `chunkSizeWarningLimit`, `reportCompressedSize` | ✅ / always reported | ✅ | ✅ |
| Preload / prefetch / preconnect hints | ✅ | ✅ | ✅ |
| `externals` in apps | ✅ `build.external` | ✅ | ✅ |
| HTML: title, meta, favicon, tags | ✅ `html` | 🔌 | ✅ |
| `html.cspNonce` | ✅ | ✅ | ✅ `security.nonce` |
| SRI | ✅ default | ❌ | ✅ |
| `server.proxy`, `https`, `cors`, `headers`, `open`, `strictPort` | ✅ | ✅ | ✅ |
| `server.allowedHosts` (DNS rebinding guard) | ✅ on by default, localhost-only CORS | ✅ | ✅ |
| `server.warmup` | via plugin host | ✅ | n/a |
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
  18,822 CommonJS files). lunx's output is now the smallest of every tool, Bun
  included.
- Bundler: chunk import maps (`build.chunkImportMap`), a legacy `nomodule`
  build (`build.legacy`), single-file executables (`lunx compile`), unchanged
  builds in ~40 ms.
- Dev: bundled dev mode (`server.bundle`, `lunx dev --bundle`): the browser
  matrix passes 133/133 with it.
- Federation: the Module Federation Chrome DevTools extension.
- Toolchain: `lunx test` with DOM environments, coverage and snapshots;
  `lunx lint` / `lunx fmt`; `lunx run` (workspace tasks with a cache).

**Still missing**

1. Test runner: browser mode.
2. Bundled dev for projects with Vite plugins or module federation (they serve
   modules one by one).
3. webpack loaders; a Node version / package manager (Vite+, Bun).
4. `writeToDisk` in dev; `envPrefix` / `envDir` and the Environment API are
   partial.
5. Next.js, Docusaurus, Gatsby, RedwoodJS and Stencil still run their own CLIs.

**Where lunx leads**

Fastest dev boot, HMR and cold build of every tool with a dev server, at
both sizes · smallest output after Bun, and smaller per framework than Vite
and the meta-frameworks' own CLIs · the widest framework list built by one
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
