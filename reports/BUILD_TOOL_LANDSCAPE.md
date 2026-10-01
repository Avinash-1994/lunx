# The build-tool landscape, measured

Every tool below was installed from npm and run on **one identical React 19 +
TypeScript app** (`index.html` → `src/main.tsx` → `src/App.tsx` with `useState`
→ `src/app.css`), on this machine: Windows 11, Node v22.18.0, 8 cores.
Reproduce with `npm run bench:arena`.

**Caveat on every lunx timing: the Rust engine has never been compiled here (no
`cargo`), so lunx ran its JavaScript fallback (`@swc/core` + LightningCSS).**

## 1. Numbers

Medians of 3 runs. `dev boot` = process spawn until `/` returns 200.
`app code` = spawn until the first `<script src>` in that HTML returns 200 —
for a module server that is one transformed module, for a bundler it is the
whole bundle, because that is what the browser needs before it can run
anything.

| tool | kind | dev boot | app code | build cold | build warm | JS out | CSS out |
|---|---|---|---|---|---|---|---|
| **bun** 1.4.2 | bundler | – | – | 296 ms | **279 ms** | **211,811 B** | 30 B |
| **esbuild** 0.28.2 | bundler | – | – | 380 ms | 390 ms | 222,973 B | 30 B |
| **rolldown** 1.2.12 | bundler, JS only | – | – | 435 ms | 402 ms | 221,449 B | **unsupported** |
| **rspack** 2.2.8 | bundler | 515 ms | 645 ms | **596 ms** | 548 ms | **219,460 B** | 29 B |
| **vite** 8.3.1 | module server | **471 ms** | **649 ms** | 616 ms | 549 ms | 220,248 B | 30 B |
| **lunx** 1.0.3 (JS fallback) | module server | 2042 ms | 2048 ms | 2842 ms | 1611 ms | 229,909 B | 30 B |
| **parcel** 2.16.4 | bundler | 3030 ms | 3036 ms | 3862 ms | 2181 ms | 221,932 B | 77 B |
| **webpack** 5.111.1 | bundler | 2212 ms | 2319 ms | 4204 ms | 4522 ms | 224,696 B | 0 B¹ |

¹ webpack's `style-loader` inlines CSS into the JS bundle, so its JS figure
carries the stylesheet.

**Where lunx actually sits: last on dev boot, last on bundle size, and sixth of
eight on build time.** It beats webpack and parcel on build and nothing else.

### What you have to install

A React app with a stylesheet, counted as packages in `node_modules` and bytes
on disk:

| tool | packages | disk |
|---|---|---|
| esbuild | **2** | **12 MB** |
| bun | 2 | 83 MB (a whole runtime) |
| rspack (+cli +dev-server) | 6 | 54 MB |
| **lunx** | **13** | **35 MB** |
| vite (+plugin-react) | 16 | 35 MB |
| parcel | 116 | 109 MB |
| webpack (+6 loaders/plugins) | 311 | 77 MB |

This is the one quantitative column lunx already wins against every
general-purpose competitor: 13 packages and a 436 KB tarball.

## 2. The bar moved in March 2026

Vite 8 ships **Rolldown** — a Rust bundler — as its default, replacing
esbuild + Rollup, with no opt-in. So the `vite` row above is already a Rust
pipeline, which is why its build lands at 549 ms rather than the multi-second
Rollup builds Vite used to post.

That reframes lunx's position: "faster than Vite" was a claim against
JavaScript Rollup. Against Rolldown, lunx's JavaScript fallback is **3.5×
behind on dev boot and 2.9× behind on build**. No amount of pipeline tuning in
JavaScript closes that — the remaining gap is compiler and bundler work that
belongs in `native/`.

Turbopack is not a competitor for a general-purpose tool yet. Vercel's own
post says the standalone, general-purpose bundler is future work — *"our
immediate focus is on Next.js to start"* and *"In time, we will reach a stable
state for the general-purpose bundler to be used outside of Next.js"* — and
production builds are still being brought to parity. It is Next-only, and
dev-first.

## 3. Capability matrix — where "all in one" is actually open

Measured first-hand where marked ✅/❌ from running the tool; otherwise from
each project's own documentation.

| | lunx | vite 8 | rspack | webpack | parcel | esbuild | bun | turbopack |
|---|---|---|---|---|---|---|---|---|
| Framework-agnostic | ✅ | ✅ | ✅ | ✅ | ✅ | partial² | partial² | ❌ Next only |
| Dev server + HMR | ✅ | ✅ | ✅ (extra pkg) | ✅ (extra pkg) | ✅ | ❌ no HMR | ✅ | ✅ |
| Production build | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | not stable |
| CSS bundling | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Zero config | ✅ | ✅ | ❌ config required | ❌ config + 6 pkgs | ✅ | n/a | ✅ | ✅ |
| Test runner | ✅ `lunx test` | ❌ vitest | ❌ rstest | ❌ | ❌ | ❌ | ✅ `bun test` | ❌ |
| Type checking | ✅ `lunx check` | ❌ tsc | ❌ | ❌ | ❌ | ❌ | ❌ strip only | ❌ |
| Bundle analysis | ✅ `lunx analyze` | ❌ plugin | ✅ | ✅ plugin | ❌ | ❌ | ❌ | ❌ |
| Module federation | ✅ | ❌ plugin | ✅ built-in | ✅ built-in | ❌ | ❌ | ❌ | ❌ |
| SSR / meta-framework | ✅ 20 adapters | ✅ SSR API | ✅ | ✅ | partial | ❌ | partial | ✅ Next |
| Supply-chain security | ✅ CVE/SBOM/SRI/CSP | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ audit only | ❌ |
| Package manager / runtime | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |

² esbuild and bun compile TS/JSX natively but have no built-in compiler for
Vue or Svelte single-file components; both need a plugin, and neither ships
one. Rolldown 1.2.12 goes further and **removed CSS bundling entirely** —
`Bundling CSS is no longer supported (experimental support has been removed)` —
so it is a bundler library for tools like Vite, not an application build tool.

## 4. What the matrix says about strategy

Two camps exist, and neither covers the whole board:

- **Framework-agnostic but multi-package.** Vite needs Vitest, tsc and plugins;
  the Rstack family is Rspack + Rsbuild + Rslib + Rstest + Rspress. You get
  breadth of frameworks, assembled from several installs.
- **All-in-one but framework-limited.** Bun is the real single-binary
  story — runtime, package manager, test runner, bundler — but has no built-in
  Vue or Svelte compiler, no federation, no type checking.

**Nobody ships framework-agnostic *and* all-in-one.** That intersection is
lunx's entire reason to exist, and the capability column above is the only one
where it is already ahead: a single `npm i lunx-dev` that has dev, build, test,
check, analyze, federation, SSR adapters and supply-chain security, for any
framework.

The risk is that the breadth is claimed rather than verified. In this session,
benchmarking the *packaged* CLI found `lunx build`, `lunx test` and
`require('lunx-dev')` fatally broken on publish, and an adapter registry that
had never been built — so every one of the 20 framework adapters was silently
inert. Breadth that crashes is worth less than narrowness that works.

Sources for the non-measured claims:
[Vite 8 beta announcement](https://vite.dev/blog/announcing-vite8-beta),
[Turbopack: Moving homes](https://vercel.com/blog/turbopack-moving-homes),
[Rolldown 1.0](https://voidzero.dev/posts/announcing-rolldown-1-0),
[Rstest](https://rstest.rs/guide/start/).
