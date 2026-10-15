# lunx against every build tool, in every area

Measured on 2026-10-15 (Linux, Node 22.22, 4 cores) with the versions below.
Speed, size and install numbers come from running each tool here
(`npm run bench:arena`, `scripts/footprint.sh`). The feature tables come from
running lunx and reading each tool's installed type definitions (Vite's
`UserConfig`, Rsbuild's `RsbuildConfig`…). Where a table cites a tool's own
documentation instead, it says so.

| tool | version | kind |
|---|---|---|
| **lunx** | 1.2.0 | dev server + build, Rolldown/Oxc |
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
| **lunx** | **158 ms** | 36 ms | **210 ms** | **215 ms** |
| Vite | 303 ms | 39 ms | 312 ms | 316 ms |
| Rspack | 246 ms | 164 ms | 256 ms | 242 ms |
| Rsbuild | 275 ms | 88 ms | 354 ms | 336 ms |
| Farm | 774 ms | 47 ms | 1,250 ms | 873 ms |
| Parcel | 940 ms | **26 ms** | 1,118 ms | 1,089 ms |
| webpack | 1,153 ms | 194 ms | 2,533 ms | 2,450 ms |
| esbuild | – | – | 39 ms | 38 ms |
| Bun | – | – | **23 ms** | **23 ms** |
| Rolldown | – | – | 173 ms | 161 ms |

**2,000 components**

| tool | dev boot | first module | HMR | build cold | build warm |
|---|---|---|---|---|---|
| **lunx** | **178 ms** | **181 ms** | **115 ms** | **363 ms** | **333 ms** |
| Vite | 242 ms | 456 ms | 148 ms | 480 ms | 445 ms |
| Rspack | 454 ms | 536 ms | 458 ms | 513 ms | 539 ms |
| Rsbuild | 638 ms | 753 ms | 286 ms | 530 ms | 527 ms |
| Parcel | 3,211 ms | 3,230 ms | 180 ms | 3,534 ms | 3,349 ms |
| webpack | 2,530 ms | 2,717 ms | 705 ms | 5,498 ms | 5,599 ms |
| Farm | failed¹ | | | | |
| esbuild | – | – | – | 85 ms | 91 ms |
| Bun | – | – | – | **47 ms** | **47 ms** |
| Rolldown | – | – | – | 228 ms | 226 ms |

¹ Farm 1.7 cannot resolve `react/jsx-dev-runtime` through a symlinked
`node_modules` (the scaled app shares the small app's).

**Verdict.** Among tools with a dev server, lunx is fastest at boot, build and
(at scale) HMR. esbuild and Bun build faster, but they are bundlers with no HMR
dev server, CSS pipeline or framework compilers. Parcel's HMR is 10 ms faster
on the small app.

## 2. Build output

What the browser downloads: JS, gzip -9.

| tool | small app | 2,000 components |
|---|---|---|
| Bun | **65,552 B** | **82,445 B** |
| Vite | 68,006 B | 85,702 B |
| **lunx** | 68,055 B | 85,749 B |
| Rolldown | 68,130 B | 86,322 B |
| esbuild | 68,967 B | 87,231 B |
| Rspack | 69,026 B | 91,460 B |
| Rsbuild | 69,256 B | 90,591 B |
| Parcel | 69,675 B | 91,079 B |
| webpack | 70,359 B | 89,442 B |
| Farm | 72,422 B | failed |

(Raw bytes rank differently: Rsbuild and Rspack are ~1.3 KB smaller than lunx
uncompressed but larger after gzip.)

**Why lunx is not first:**

1. **CommonJS calls.** React ships CommonJS. lunx and Vite (both Rolldown)
   call its exports through the module object, as `(0,x.jsx)("div",…)`. Bun
   binds them to local names: `e("div",…)`. That is ~6 bytes per JSX element
   and per hook call. At 2,000 components it accounts for nearly all of Bun's
   4% lead.
2. **License comments.** lunx keeps third-party `@license` headers in the JS
   (5 in React). Vite and Bun drop them. Rsbuild moves them to
   `*.LICENSE.txt`. This is the whole 49 B gap to Vite.
3. **Per-framework, lunx is smallest.** In `npm run test:parity` (vanilla,
   React, Preact, Vue, Svelte, Solid, Lit, a two-page app), lunx's gzip JS is
   smaller than Vite 8's in every scenario. For Angular it is smaller than
   `ng build`'s (31.7 KB vs 31.9 KB).

Both causes can be fixed in lunx (§9, items 1–2).

## 3. Frameworks

✅ built in · 🔌 official/first-party plugin · 🧩 community plugin · ❌ none.
Competitor cells follow each tool's own documentation.

| | lunx | Vite | Rsbuild | Rspack / webpack | Parcel | Farm | Bun |
|---|---|---|---|---|---|---|---|
| React (Fast Refresh) | ✅ | 🔌 | 🔌 | 🔌 | ✅ | 🔌 | ✅ |
| React Compiler | ❌ | 🔌 (Babel) | ✅ Rust (2.1) | 🧩 | ❌ | ❌ | ❌ |
| React Server Components | only via Waku / React Router | 🔌 `plugin-rsc` | ✅ (2.0) | experimental (2.0) | ✅ (beta) | ❌ | ❌ |
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
| Storybook | ❌ no builder | ✅ builder | ✅ builder | ✅ builder |
| Vike, Vitest, Histoire, Slidev… (Vite-only ecosystem) | ❌ untested | ✅ | ❌ | ❌ |

## 4. Module federation

| | lunx | webpack / Rspack (`@module-federation/enhanced`) | Vite (`@module-federation/vite`) | Rsbuild |
|---|---|---|---|---|
| Expose / consume, shared singletons, `requiredVersion`, `strictVersion`, `eager` | ✅ | ✅ | ✅ | ✅ |
| Interop with webpack / Rspack apps | ✅ both directions (6/6 pairings) | ✅ | ✅ | ✅ |
| `mf-manifest.json` | ✅ | ✅ | ✅ | ✅ |
| Dev HMR across host and remote | ✅ | ✅ | partial | ✅ |
| `loadRemote`, `preloadRemote` | ✅ | ✅ | ✅ | ✅ |
| `registerRemotes` (remotes added at runtime) | ❌ | ✅ | ✅ | ✅ |
| Runtime plugins (retry, fallback, auth…) | ❌ | ✅ | ✅ | ✅ |
| Type hints for remotes (`dts`) | ❌ (**docs claim it**) | ✅ | ✅ | ✅ |
| `shareStrategy`, `shareScope`, `import: false` | ❌ | ✅ | ✅ | ✅ |
| Remote as object (`{ entry, type }`) | ❌ string only | ✅ | ✅ | ✅ |
| Chrome DevTools extension | ❌ | ✅ | ✅ | ✅ |

## 5. Bundler features

| | lunx | Vite | Rsbuild / Rspack | webpack | Parcel | esbuild | Bun |
|---|---|---|---|---|---|---|---|
| Tree shaking, scope hoisting, code splitting | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CSS code splitting | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CSS modules, PostCSS, Sass, Less, Stylus, Tailwind v4 | ✅ | ✅ | ✅ | loaders | ✅ | partial | partial |
| `new Worker(new URL(…, import.meta.url))` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `import W from './w.js?worker'` | ❌ **fails** | ✅ | ✅ (2.1) | ❌ | ❌ | ❌ | ❌ |
| `` import(`./locales/${lang}.js`) `` | ❌ **not bundled, 404 at runtime** | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `import.meta.glob` | ✅ | ✅ | ✅ (`import.meta.webpackContext`) | ✅ (`require.context`) | ✅ glob | ❌ | ❌ |
| `.wasm?init` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Wasm ESM import (`import { f } from './a.wasm'`) | ❌ | ✅ (8.1) | ✅ | ✅ | ❌ | ❌ | partial |
| Syntax lowering for older browsers (`build.target` / browserslist) | ❌ always ESNext | ✅ | ✅ | ✅ | ✅ | ✅ | partial |
| Polyfills (core-js usage, legacy `nomodule`) | ❌ | 🔌 `plugin-legacy` | ✅ `output.polyfill` | ✅ | ✅ differential | ❌ | ❌ |
| `build.manifest` (Laravel, Rails, Django backends) | ❌ | ✅ | ✅ | 🔌 | ✅ | ✅ metafile | ❌ |
| `ssrManifest` | ❌ | ✅ | ✅ | 🔌 | ❌ | ❌ | ❌ |
| Chunk import map (stable hashes) | ❌ | ✅ (8.1) | ❌ | ❌ | ❌ | ❌ | ❌ |
| CDN URLs per asset (`renderBuiltUrl` / `assetPrefix`) | ❌ (only `base`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Drop `console` / `debugger` | ❌ | via minifier options | ✅ `removeConsole` | ✅ (Terser) | ❌ | ✅ `drop` | ✅ |
| Legal comments (measured) | kept inline | dropped | Rsbuild: `.LICENSE.txt`; Rspack: dropped | dropped | dropped | kept inline | dropped |
| Library mode (es, cjs, umd, iife, `.d.ts`) | ✅ | ✅ (no dts) | ✅ Rslib | ✅ | ✅ | ✅ | ✅ |
| Persistent build cache | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Remote (shared) cache | ❌ (**option accepted, does nothing**) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Precompressed .gz / .br | ✅ | 🔌 | 🔌 | 🔌 | ✅ | ❌ | ❌ |
| Bundled dev mode for 10k+ module apps | ❌ | ✅ experimental (8.1) | n/a (bundler) | n/a | n/a | n/a | n/a |
| Single-file executable | ❌ | ❌ (Vite+: `vp pack`) | ❌ | ❌ | ❌ | ❌ | ✅ `--compile` |

## 6. Advanced options

Options a production project reaches for. A lunx ❌ means neither
`lunx.config` nor a `vite.config` it reads can set it today.

| option | lunx | Vite | Rsbuild |
|---|---|---|---|
| `base`, `outDir`, `publicDir`, `define`, `alias`, env files | ✅ | ✅ | ✅ |
| `envPrefix`, `envDir` | partial | ✅ | ✅ |
| `sourcemap` (inline, hidden, external) | ✅ | ✅ | ✅ |
| `minify` on/off | ✅ | ✅ | ✅ |
| `cssMinify`, `cssTarget` | ❌ | ✅ | ✅ |
| `assetsInlineLimit` | ✅ | ✅ | ✅ |
| `assetsInclude` | ❌ | ✅ | ✅ |
| `emptyOutDir` / `cleanDistPath` | always | ✅ | ✅ |
| `copyPublicDir` / `copy` | always | ✅ | ✅ |
| Output file name templates | ❌ fixed `assets/[name].[hash]` | ✅ | ✅ |
| Chunk splitting | `manualChunks` by package | ✅ `advancedChunks` | ✅ strategies |
| `chunkSizeWarningLimit`, `reportCompressedSize` | ❌ | ✅ | ✅ |
| Preload / prefetch / preconnect hints | modulepreload only | ✅ | ✅ |
| `externals` in apps | ❌ (libraries only) | ✅ | ✅ |
| HTML: title, meta, favicon, tags | ❌ | 🔌 | ✅ |
| `html.cspNonce` | ❌ (CSP via `lunx security headers`) | ✅ | ✅ `security.nonce` |
| SRI | ✅ default | ❌ | ✅ |
| `server.proxy`, `https`, `cors`, `headers`, `open`, `strictPort` | ✅ | ✅ | ✅ |
| `server.allowedHosts` (DNS rebinding guard) | partial | ✅ | ✅ |
| `server.warmup` | via plugin host | ✅ | n/a |
| `middlewareMode` (embed in Express) | ❌ for apps | ✅ | ✅ |
| `writeToDisk` in dev | ❌ | ❌ | ✅ |
| Environment API (client + SSR + edge in one config) | partial (plugin host) | ✅ | ✅ `environments` |
| JS API (`build()`, `createServer()`) | partial | ✅ | ✅ |

## 7. Toolchain around the bundler

| | lunx | Vite (+ Vite+) | Rstack | Parcel | Bun |
|---|---|---|---|---|---|
| Scaffolding | ✅ `lunx create`, 27 templates | ✅ `create-vite`, `vp create` | ✅ | ❌ | ✅ |
| Test runner | basic: `describe`/`it`/`expect`/`vi`, TS, watch | ✅ Vitest | ✅ Rstest | ❌ | ✅ `bun test` |
| · DOM environment (jsdom / happy-dom) | ❌ | ✅ | ✅ | | ✅ |
| · Coverage | ❌ | ✅ | ✅ | | ✅ |
| · Snapshots | ❌ | ✅ | ✅ | | ✅ |
| · Browser mode | ❌ | ✅ | ✅ | | ❌ |
| Type check | ✅ `lunx check`, dev overlay | ✅ `vp check` (tsgo) | ❌ | ❌ | ❌ |
| Lint | ❌ | ✅ `vp lint` (Oxlint) | ❌ | ❌ | ❌ |
| Format | ❌ | ✅ `vp fmt` (Oxfmt) | ❌ | ❌ | ❌ |
| Monorepo task runner with cache | ❌ | ✅ `vp run` | ❌ | ❌ | partial (workspaces) |
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

## 9. What others have and lunx does not, by priority

**P1 — correctness, or claimed and missing (fix before 1.2.0)**

1. `` import(`./x/${name}.js`) `` is not bundled and fails at runtime (Vite,
   webpack, Rspack, Parcel do it).
2. `import W from './w.js?worker'` fails the build.
3. `build.target` / browserslist: no syntax lowering for older browsers.
   `build.targets` is in lunx's schema but nothing reads it.
4. `build.manifest` for backend integrations (Laravel, Rails, Django, Symfony).
5. Docs promise `federation.dts`. It does not exist; implement or remove from docs.
6. `cache.remote` is accepted but does nothing; implement or reject.
7. Error code frames print ANSI colours even with `NO_COLOR=1`.

**P2 — output size (lunx #1 instead of #2–3)**

1. Bind CommonJS named imports (React's `jsx`, hooks) to locals, as Bun does
   (~4% gzip on JSX-heavy apps).
2. `build.legalComments: 'inline' | 'none' | 'linked'`, default `linked`
   (one `.LICENSE.txt` file per chunk, as Rsbuild does).

**P3 — options production projects expect**

`renderBuiltUrl` / asset CDN prefix, `emptyOutDir`, `copyPublicDir`,
`chunkSizeWarningLimit`, file name templates, `externals` for apps, drop
`console`, `cssTarget` / `cssMinify`, `ssrManifest`, preload/prefetch hints,
`html.cspNonce`, HTML title/meta/favicon injection, `middlewareMode`.

**P4 — ecosystem**

Storybook builder · React Compiler · generic React Server Components ·
federation `registerRemotes`, runtime plugins, `shareStrategy`, object remotes ·
Wasm ESM imports · chunk import maps · polyfills / legacy browsers.

**P5 — toolchain breadth (Vite+ and Bun)**

Test runner: DOM environment, coverage, snapshots, browser mode · lint
(Oxlint) and format (Oxfmt) · monorepo task runner with cache · bundled dev
mode for very large apps · single-file executables.

**Where lunx already leads**

Fastest dev boot, HMR at scale and full-tool builds of everything measured ·
smallest output per framework against Vite and `ng build` · the widest
framework list built by one tool (10 app frameworks, 12 meta-frameworks
built, 5 delegated) · module federation interoperable with webpack and Rspack ·
supply-chain security, PWA, Electron, `.gz`/`.br` and SRI built in.

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
