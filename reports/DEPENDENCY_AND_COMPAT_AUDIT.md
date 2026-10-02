# Dependency reduction + cross-framework compatibility

Working copy: `D:\lunx-work\lunx` (branch `master`, uncommitted).

## 1. Runtime dependencies: 44 → 6

Fresh `npm install --omit=dev`:

| | before | after |
|---|---|---|
| direct runtime deps | 44 | **6** |
| total packages installed | 304 | **12** |
| `node_modules` size | 322 MB | **31 MB** |

Kept: `@swc/core`, `lightningcss`, `esbuild`, `acorn`, plus the two in-repo
workspace packages (`@lunx/adapter-core`, `@lunx/security`).

### Replaced with own implementations (`src/internal/`)

| Module | Replaces | Verified by |
|---|---|---|
| `colors.ts` | `kleur`, `chalk` | output compared against kleur |
| `ws.ts` | `ws` | RFC 6455 server; 12 checks against the `ws` client |
| `watcher.ts` | `chokidar` | 11 checks on a real temp tree |
| `yaml.ts` | `js-yaml` | 21 differential cases vs js-yaml |
| `dotenv.ts` | `dotenv` | 14 differential cases vs dotenv |
| `schema.ts` | `zod` | 55 differential cases vs zod |
| `store.ts` | `better-sqlite3` | 37 checks (content cache + record store) |
| `cli-args.ts` | `yargs` | 32 cases, 20 compared directly against yargs |
| `rpc.ts` | `@trpc/server`, `@trpc/client` | 14 checks incl. an HTTP handler |
| `proxy.ts` | `http-proxy` | 12 checks incl. WS upgrade + 500 KB streaming |
| `self-signed.ts` | `selfsigned` | hand-rolled X.509 DER; accepted by Node's TLS stack and by `tls.checkServerIdentity` |
| `open-editor.ts` | `launch-editor` | — |
| `uws.ts` | git-only `uWebSockets.js` | now optional, never a declared dep |

`npm run test:internal` → **8/8 suites, 231 checks passing**.

### Moved out of runtime

- Optional **peer** deps (the user's frameworks, not ours): `react`, `react-dom`,
  `react-refresh`, `vue`, `@vue/compiler-sfc`, `@vue/server-renderer`,
  `svelte-preprocess`, `esbuild-svelte`, `babel-preset-solid`, `@babel/*`,
  `@tauri-apps/api`, `axe-core`. All are now lazily resolved from the project.
- Removed as never imported: `level`, `@types/level`, `rxjs`, `@node-rs/xxhash`.
- `node-fetch` dropped — Node >= 20 has global `fetch`.
- `uWebSockets.js` was a **git dependency**, which breaks `npm ci` in offline
  and locked-down environments. It is no longer declared; the shim falls back to
  `node:http` + the internal WebSocket server.

## 2. Cross-framework browser matrix

`npm run test:browser-matrix` scaffolds a minimal app per framework, starts
`lunx dev`, drives it in real Chromium, edits a file to check HMR, then runs
`lunx build` and serves `dist/` to confirm the production output renders.

**15/42 → 39/42 checks.**

| framework | dev | css | console | hmr | build | preview |
|---|---|---|---|---|---|---|
| vanilla-ts | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| react | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| preact | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| vue | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| svelte | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| solid | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| lit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Dev-server boot: ~290–430 ms across all seven.

## 3. Bugs found and fixed

All were pre-existing; several were confirmed against the unmodified checkout.

1. **HMR WebSocket never answered.** `devServer.minimal.ts` hands a bare
   `http.Server` to the full server, which only took its WebSocket server from
   the uWS shim — so on the normal path nothing served `/__lunx_hmr`.
2. **Dev server bound IPv4-only.** `0.0.0.0` leaves `::1` unserved, and browsers
   resolve `localhost` to `::1` first, so HMR sockets hung. Now binds `::`.
3. **WebSocket frame interleaving.** Header and payload were written separately,
   so two `send()` calls in one tick corrupted the stream and the browser closed
   with 1006. Now one write per frame (regression test added).
4. **A closed tab could kill the dev server** — an unhandled socket `error`.
5. **React Fast Refresh was broken on cold start.** The minimal server served
   `index.html` straight off disk, skipping the Refresh preamble, so the first
   load died with `$RefreshReg$ is not defined`.
6. **JSX compiled with the classic runtime and no React import.** Any component
   without a hand-written `import React` failed. Automatic is now the default,
   and JSX is no longer pre-transformed by the non-framework-aware fast path.
7. **Production bundles were syntactically invalid.** Modules are wrapped in a
   CommonJS factory but were never lowered out of ESM →
   `'import' and 'export' may only appear at the top level`. Fixed for both the
   SWC path and framework compilers (Vue/Svelte/Astro).
8. **`import './app.css'` broke the bundle** — extracted style modules had no JS
   factory, so the entry threw `Module not found`.
9. **Per-module minification corrupted output.** Each module was minified before
   wrapping, mangling `Object`/`exports`/`require`. Now minified once per bundle.
10. **Bundler wrapper used `h` as a parameter name**, colliding with any
    dependency that declares a top-level `h` (`Identifier 'h' has already been
    declared`).
11. **Minified ESM dependencies were invisible.** The import scanner required
    whitespace after the keyword, so `import"lit-html";export*from"x"` — how
    published packages ship — yielded *no* imports and their dependencies never
    entered the graph.
12. **ESM-only packages could not be resolved.** Resolution used
    `require.resolve` only, which applies the `require` condition; added an
    `exports`-map resolver and support for `#subpath` imports.
13. **Preact/Solid builds pulled in `react/jsx-runtime`** when React happened to
    be installed. The JSX import source is now detected and threaded into both
    the transform and the dependency graph.
14. **`import { defineConfig } from 'lunx'` failed** — the package publishes as
    `lunx-dev`. The config loader now supplies it for either name.
15. **`lunx build` and `lunx preview` ignored `--root`**, so they could only
    build the current directory. Added `--root`/`-r` and `--outDir`.
16. **A CVE in any transitive dependency aborted the build.** Now warns; fails
    only when `security.vulnSeverity` is set or `LUNX_SECURITY_STRICT=1`.
    Secret detection still fails the build, as documented.

## 4. Known remaining gaps

- **svelte / solid `preview`**: the built bundle still leaves one specifier
  unmapped (`#client/constants` for svelte). Graph resolution succeeds in
  isolation, so the remaining fault is in how `execute.ts` looks up the
  specifier map for those modules. Dev, HMR and `build` all pass.
- **vanilla-ts HMR**: a plain ES module with no framework accept handler does
  not hot-apply; the change needs a manual reload.
- **React component hot-apply** works, but some edits fall back to a full page
  reload rather than preserving state.
- `@swc/core`'s platform binary was missing from a plain install here, which
  silently disabled all transforms. Pinned in devDependencies for this checkout;
  worth checking how it is declared for published installs.
- The Rust native path was not exercised (no `cargo` in this environment), so
  every fix above was verified on the JS fallback engine. The equivalent code in
  `native/src` may need the same JSX-runtime and CJS-lowering treatment.

## 5. Competitive rating

See [COMPETITIVE_RATING.md](COMPETITIVE_RATING.md) for the measured
head-to-head against Vite 8.3.1 (`npm run bench:vs-vite`) and the nine
publish-blocking bugs that benchmarking the *packaged* CLI uncovered.

## 6. Build-tool landscape and the plan

- [BUILD_TOOL_LANDSCAPE.md](BUILD_TOOL_LANDSCAPE.md) — lunx measured against
  vite, rspack, webpack, parcel, esbuild, bun and rolldown on one identical
  app (`npm run bench:arena`), plus a capability matrix.
- [ALL_IN_ONE_PLAN.md](ALL_IN_ONE_PLAN.md) — the plan that follows from it.
- [CLI_SURFACE.json](CLI_SURFACE.json) — all 21 commands run from a packaged
  install (`npm run test:cli-surface`).
