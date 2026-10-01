# Where lunx stands — measured, not estimated

## Current (Linux, Node 22.22, 4 cores, Rust engine built)

`npm run bench:arena -- --runs 5` — one React 19 + TypeScript app, eight tools,
medians. Raw data: [BENCH_ARENA.json](BENCH_ARENA.json).

| tool | dev boot | first app module | build cold | build warm | JS bytes |
|---|---|---|---|---|---|
| **lunx** | **291 ms** | **302 ms** | 462 ms | 457 ms | 219,626 |
| vite 8 (Rolldown) | 381 ms | 485 ms | 792 ms | 431 ms | 220,248 |
| rspack | 339 ms | 373 ms | 304 ms | 324 ms | 219,460 |
| webpack | 1368 ms | 1461 ms | 3392 ms | 3571 ms | 224,696 |
| parcel | 1315 ms | 1324 ms | 1420 ms | 1546 ms | 221,951 |
| esbuild (bundler only) | – | – | 65 ms | 60 ms | 222,973 |
| bun (bundler only) | – | – | 39 ms | 37 ms | 211,811 |
| rolldown (bundler only) | – | – | 404 ms | 269 ms | 221,449 |

Read plainly: **lunx has the fastest dev server of the module servers and
bundlers measured, a build at parity with Vite (Vite varied 355–792 ms cold
across runs), and the second-smallest bundle.** Rspack builds faster; esbuild
and Bun are bundlers without a dev server, HMR, CSS pipeline or framework
compilers, so their build column is not a like-for-like comparison. The lunx
build time includes work the others skip: precompressed `.gz`/`.br`, SBOM,
SRI and a secret scan.

What changed since the Windows measurements below (same app):

| | before | now |
|---|---|---|
| dev boot | 2042 ms | 291 ms |
| build cold | 2988 ms | 462 ms |
| bundle JS | 229,909 B | 219,626 B |
| browser matrix | 39/42 on Windows, **0/42 on Linux** | 102/102 (17 stacks) |
| library conformance | – | 48/48 |
| CLI from a packed install | 20/21 | 19/21, 0 crashes (2 deliberate) |

Correctness coverage, all in real Chromium, dev and production:

- `npm run test:browser-matrix` — React, Preact, Vue, Svelte, Solid, Lit,
  vanilla TS, Angular, Alpine, Mithril, jQuery, three.js, React + Tailwind v4,
  React + styled-components, React Router, Vue Router, Sass: dev, CSS, clean
  console, HMR, build, production render + CSS.
- `npm run test:conformance` — CJS (named, default, function, `__esModule`,
  NODE_ENV switch, require chains), ESM-only, dual packages, `exports`
  conditions and patterns, `#imports`, legacy `browser` field, `module` field,
  JSON, dynamic import, top-level await, module workers, wasm,
  `new URL(…, import.meta.url)`, `import.meta.glob`, `?raw`, `?url`, `?inline`.

---

## Earlier measurements (Windows 11, Node 22.18, 8 cores, JS engine)

Every number below was produced on this machine (Windows 11, Node v22.18.0,
8-core) by `scripts/bench-vs-vite.mjs` and `scripts/browser-matrix.mjs`.
**Caveat that applies to all timings: the Rust engine was never compiled (no
`cargo` in this environment), so lunx ran its JavaScript fallback engine
(`@swc/core` + LightningCSS) throughout.** `lunx info` now reports which engine
is live; it printed `not installed — JS fallback` for every run here.

Same React 19 + TypeScript app for both tools: `index.html` → `src/main.tsx` →
`src/App.tsx` (`useState`) → `src/app.css`. Medians of 5 runs.

## 1. Head-to-head vs Vite 8.3.1

`npm run bench:vs-vite` (5 runs, medians):

| | lunx (JS fallback) | vite 8.3.1 | verdict |
|---|---|---|---|
| Dev server cold boot (spawn → `/` served) | 1310 ms | **707 ms** | vite 1.9× faster |
| First transform of `src/main.tsx` | **53 ms** | 98 ms | **lunx 1.8× faster** |
| Production build, cold | 2988 ms | **867 ms** | vite 3.4× faster |
| Production build, warm | 2113 ms | **740 ms** | vite 2.9× faster |
| Bundle (JS, minified) | 229,909 B | **220,250 B** | vite 4.4% smaller |
| Bundle, brotli | **68,971 B** | not emitted | lunx ships `.br`/`.gz` |
| Install: packages | **13** | 15 | lunx |
| Install: `node_modules` | 35 MB | 35 MB | tie |
| Published tarball | **436 KB** | 3.1 MB | lunx |

Read plainly: **lunx is ahead on per-module transform speed and install
footprint, level on bundle size, and behind on cold boot and whole-project
build.** The transform win is the one a working day pays most often — it is
what every file save costs — and it is the part SWC does. The build loss is
pipeline overhead rather than compiler speed; the profile below says where it
goes.

Against the dependency work specifically:

| | published `lunx-dev@1.0.2` | this branch | vite 8.3.1 |
|---|---|---|---|
| packages installed | 276 | **13** | 15 |
| `node_modules` | 300 MB | **35 MB** | 35 MB |

## 2. Where the build time goes

`node --cpu-prof` over one production build, 2765 ms of samples:

| self time | what |
|---|---|
| 656 ms | `minifySync` — SWC whole-bundle minify |
| 655 ms | `zlib.processChunkSync` — gzip + brotli, **synchronous**, max quality |
| 238 ms | `transformSync` — SWC per-module transform (the actual compile) |
| 336 ms | acorn (import scanning) |
| 206 ms | idle |

Only 238 ms of a ~3 s build was compiling. Acted on:

- Compression moved to the async zlib API (libuv threadpool, artifacts
  compress concurrently instead of serially on the main thread), brotli
  quality 11 → 9 (~1% larger, several times faster), and files under 1 KB are
  no longer compressed at all — the CSS artifact in this app is 30 bytes and
  was getting two compressed siblings.
- The double minify pass is now a documented switch rather than an accident:
  esbuild minified every artifact and *then* SWC minified the same bundle
  again. Keeping both is the default because it genuinely wins on size; the
  trade is now measurable and selectable.

| configuration | build | bundle JS |
|---|---|---|
| default (`globalMinify: true`) | 2.1 s warm | 229,909 B |
| `build.globalMinify: false` | 2.0–2.5 s | 245,400 B (+6.3%) |
| `+ build.compress: false` | 1.86–2.1 s | 245,400 B |

Warm production builds went from ~3.1 s to ~2.1 s on the same app and the same
output byte-for-byte, so the remaining gap to vite is ~2.9× rather than ~3.6×.
What is left is pipeline work, not compiler work: only 238 ms of it compiles.

## 3. Framework coverage

`npm run test:browser-matrix` — scaffolds an app per framework, runs `lunx dev`,
drives real Chromium, edits a file to verify HMR, then `lunx build` and serves
`dist/`. **39/42 checks, 7/7 frameworks.**

| framework | dev | css | console | hmr | build | preview | boot |
|---|---|---|---|---|---|---|---|
| vanilla-ts | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | 555 ms |
| react | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 562 ms |
| preact | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 580 ms |
| vue | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 550 ms |
| svelte | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | 558 ms |
| solid | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | 599 ms |
| lit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 553 ms |

## 4. The publish blockers found while benchmarking

Benchmarking against the *packaged* CLI rather than the source tree is what
turned these up. Each one was reproduced from a real `npm install` of a
`npm pack` tarball.

1. **`lunx build` could not start.** `scripts/postbuild.js` deleted `dist/ai`,
   `dist/marketplace`, `dist/visual` and `dist/test` from the tarball to hold a
   self-imposed 1.6 MB size cap, while `cli/commands/build.js` imported
   `../../ai/telemetry.js`, `index.js` imported `./marketplace/plugin-adapter.js`,
   `cli.js` imported `./test/runner.js` and `dev/devServer.js` imported
   `../visual/*`. Published `lunx-dev@1.0.2` happens to predate the prune and
   still carries those folders, so this was aimed squarely at the next release.
   The cap is now 1.8 MB (1.76 MB used; vite unpacks to ~3.4 MB) and postbuild
   fails the build on any dangling import rather than shipping one.
2. **`@lunx/security` and `@lunx/adapter-core` were `file:` dependencies**
   pointing at `packages/`, which `files` excluded from the tarball. npm
   creates `node_modules/@lunx/security → node_modules/lunx-dev/packages/…`,
   so in every real install those symlinks dangled and the post-build security
   stage threw `Cannot find package '@lunx/security'`. Reproduced against
   published 1.0.2. Both packages are now built by `npm run build` and shipped
   inside the tarball.
3. **`@lunx/adapter-core` had never been built** — no `dist/` existed, so
   `registry.detect()` was unreachable and *every* framework adapter was
   silently inert behind a `catch`. `lunx build` now prints
   `[lunx] adapter: react`, which it never did before.
4. **`acorn-walk` was imported but never declared** (`fix/ast-transforms.ts`,
   `test/coverage.ts`), so `lunx build` died with `ERR_MODULE_NOT_FOUND` in any
   install while passing in-repo because a devDependency supplied it. Replaced
   with `src/internal/ast-walk.ts`, verified differentially against acorn-walk
   (14 checks), so the runtime dependency count stays at 6.
5. **`glob`, `puppeteer` and `rolldown` were statically imported and undeclared**
   — `glob` took down the SolidStart adapter (replaced with a local directory
   walk), `puppeteer` took down every module in `src/audit/` (now a lazy load
   with an install hint; it downloads a ~170 MB browser and must not be a
   dependency), `rolldown` likewise.
6. **`lunx build --root <dir>` scanned the wrong directory.** `outDir` was
   resolved against the process cwd, not the project root, so the secret scan,
   SBOM and SRI/CSP hardening all ran over whatever sat in the caller's cwd.
   On this repo that meant scanning lunx's own `dist/`, where the security
   module's pattern definitions tripped its own detector and aborted the build.
7. **`lunx info` always claimed the Rust engine was present**, printing the
   package version plus `(rust-notify)` unconditionally — so a bug report from
   a machine on the JS fallback was indistinguishable from one on native.
8. **`build.minify: false` was ignored**; the SWC whole-bundle pass ran anyway.
9. **A stray `[DEBUG]` log** printed on every build whenever the SolidStart
   adapter failed to import, which was always (see 3).

## 5. What the CLI surface audit found

`npm run test:cli-surface` packs the repo, installs the tarball into a
scaffolded app and runs all 21 commands. **11/21 → 20/21 passing, 4 crashes →
0.** Nine further defects, all of which only appear once the package is
installed rather than run from the source tree:

10. **`lunx dev`, `lunx build` and `lunx analyze` all died on a default
    install** with `Failed to load native binding`. `^1.15.24` resolves to
    `@swc/core` 1.16.13, whose native addon rejects its own cache directory
    over a Windows AppContainer ACL. 1.15.24 works in the identical install,
    and the same failure takes down webpack + `swc-loader` in the benchmark
    arena, so it is upstream, not ours — but with no Rust engine compiled
    there is nothing to fall back to, so the range is now pinned `~1.15.24`.
11. **`lunx report` crashed** on `axe-core`: a static import of an *optional*
    peer, which npm does not install. The postbuild guard had treated every
    declared peer as satisfied; optional peers no longer count. The import was
    dead anyway — axe is injected into the page by file path and runs in the
    browser.
12. **`lunx ssr` refused to start at all** without `uWebSockets.js`, a git
    dependency Lunx deliberately does not declare. There is now a `node:http`
    implementation of the slice of the uWS `App()` API the SSR server uses
    (`src/internal/uws-node.ts`), so the advertised feature works on a default
    install; real uWS stays the fast path when installed.
13. **`lunx test` could not run a TypeScript test file** — it imported test
    files straight through node's ESM loader. On Windows it failed even
    earlier, with `ERR_UNSUPPORTED_ESM_URL_SCHEME`, because an absolute path
    beginning `C:\` parses as a URL scheme. Fixed with `pathToFileURL` plus
    `src/test/ts-hooks.ts`, loader hooks that compile `.ts`/`.tsx` through SWC
    and honour TypeScript's "import the `.js`, resolve the `.ts`" convention.
14. **Test discovery only matched `_test.ts`**, so the near-universal
    `foo.test.ts` convention reported "No test files found" from a runner that
    worked. It now matches `.test.`/`.spec.` across ts/tsx/mts/js/jsx/mjs,
    skips `node_modules`/`dist`/`.git`, and defaults to the project root rather
    than a `tests/` directory most projects do not have.
15. **`lunx check` printed npx's error, not its own.** It ran `npx tsc`, which
    goes to the registry when TypeScript is absent and prints *"This is not the
    tsc command you are looking for"*. It now resolves the compiler from the
    project and says plainly when it is missing.
16. **`lunx why` was impossible to satisfy.** It told the user to run
    `lunx build` first, but the engine keeps its graph in memory, so a previous
    process could never help. It also compared the user's target against node
    ids, which are content hashes, so nothing ever matched.
17. **`lunx inspect` reported an empty graph as a valid one** — "Total Modules:
    0 … ✅ Graph is valid (no cycles)" — because neither it nor `why` expanded
    the `index.html` entry into the scripts it references. Both now share
    `src/resolve/build-graph.ts`, replacing a copy of the engine's graph setup
    that carried a comment admitting the duplication. `inspect` crawls 15
    modules on the same app.
18. **`lunx preview` bound `localhost` literally**, which resolves to `::1`
    first, leaving `127.0.0.1` refused — the same IPv4/IPv6 split that hung the
    dev server's HMR socket.
19. **`lunx create --template` was rejected** with "Unknown argument" although
    every other scaffolder uses that flag name; it is now an alias of
    `--framework`.

## 6. Known gaps

- **svelte / solid `preview`**: the production bundle leaves one specifier
  unmapped (`#client/constants` for svelte). Dev, HMR and `build` pass.
- **vanilla-ts HMR**: a plain ES module with no accept handler does not
  hot-apply; the edit needs a manual reload.
- **React hot-apply** sometimes falls back to a full reload instead of
  preserving state.
- **`@swc/core` 1.16.x will not load on this machine.** `^1.15.24` resolves to
  1.16.13, whose native addon refuses its own cache directory
  (`DACL grants replacement rights … to SID S-1-15-3-…`, a Windows AppContainer
  SID) and fails with `Failed to load native binding`; 1.15.24 works in the
  same install. Since the JS fallback has nothing to fall back *to*, this is
  fatal rather than degrading. lunx now explains the failure and names
  `~1.15.24` as the workaround instead of surfacing SWC's bare message, but the
  range is still `^1.15.24` — pinning it is a call for the maintainer to make.
- **The Rust engine is unverified.** No `cargo` here, so every fix was
  validated on the JS fallback; `native/src` likely needs the same
  JSX-runtime and CommonJS-lowering treatment.
