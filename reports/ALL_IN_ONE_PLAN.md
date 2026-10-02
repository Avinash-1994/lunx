# Plan: one tool for all web development

## The purpose, stated plainly

A developer installs `lunx` and installs nothing else: dev server, bundler,
test runner, type check, bundle analysis, supply-chain security, SSR and
meta-framework support, module federation — for **any** framework or library.
No vite + vitest + tsc + plugins. No webpack + six loaders. No
rspack + rsbuild + rstest. One install, every framework.

## Why that is the right bet (and the part that is at risk)

From [BUILD_TOOL_LANDSCAPE.md](BUILD_TOOL_LANDSCAPE.md), measured on one
identical React app across eight tools, the field splits in two and neither
half covers the board:

- **Framework-agnostic but multi-package**: Vite (+ Vitest + tsc + plugins),
  the Rstack family (Rspack + Rsbuild + Rslib + Rstest).
- **All-in-one but framework-limited**: Bun — one binary for runtime, package
  manager, test runner and bundler, but no built-in Vue or Svelte compiler, no
  federation, no type checking.

**No tool is both.** That intersection is lunx's whole reason to exist, and the
capability matrix is the one place lunx already leads.

The risk is that the breadth is *claimed* rather than *verified*. This session
found `lunx build`, `lunx test` and `require('lunx-dev')` fatally broken in a
real install, and `@lunx/adapter-core` never built — which meant all 20
framework adapters were silently inert behind a `catch`. Breadth that crashes
is worth less than narrowness that works. So: **verify the breadth before
adding to it.**

## The speed problem is now a different problem

Vite 8 shipped Rolldown — a Rust bundler — as its default in March 2026. The
bar is no longer JavaScript Rollup:

| | lunx (JS fallback) | vite 8.3.1 (Rolldown) | best in field |
|---|---|---|---|
| dev boot | 2042 ms | **471 ms** | vite |
| build warm | 1611 ms | 549 ms | **bun 279 ms** |
| bundle JS | 229,909 B | 220,248 B | **bun 211,811 B** |
| install | **13 pkgs / 35 MB** | 16 pkgs / 35 MB | esbuild 2 / 12 MB |

lunx is **last of eight on dev boot and bundle size**, sixth of eight on build.
Pipeline tuning in JavaScript will not close a 3.5× gap against a Rust
pipeline — this session already took the cheap wins (duplicate minify pass,
synchronous max-quality compression) and recovered ~1 s of a 3 s build. What
remains is compiler and bundler work that belongs in `native/`, which has
never been compiled or verified in this environment.

So performance work has one precondition: **get the Rust engine built,
verified and shipping.** Everything else is a rounding error against a 3.5×
architectural gap.

## Phase 1 — Make the claimed surface real

No new features. Close the distance between what the README implies and what
runs.

**1.1 Every CLI command works from a packaged install.** ✅ **Done.**
`npm run test:cli-surface` packs the repo, installs the tarball into a
scaffolded React + TS app and runs all 21 commands, classifying each as PASS,
DELIBERATE (an intended message) or CRASH (a stack trace,
`ERR_MODULE_NOT_FOUND`, an unhandled rejection).

**11/21 → 20/21 passing, 4 crashes → 0.** The one remaining non-pass is
`lunx report`, which needs Puppeteer — a ~170 MB browser download that should
stay optional, and it now says so instead of throwing. See
[CLI_SURFACE.json](CLI_SURFACE.json) and section 4 of
[COMPETITIVE_RATING.md](COMPETITIVE_RATING.md) for the nine defects this
found.

**1.2 The three known matrix failures.** svelte/solid production `preview`
(one unmapped specifier, `#client/constants`); vanilla-ts HMR (plain ESM, no
accept handler); React hot-apply falling back to full reload.
*Done when:* 42/42.

**1.3 Framework matrix 7 → 20.** The adapters exist and, until this session,
none of them could even load. Add to `browser-matrix.mjs` in order of user
population: angular, astro, qwik, nextjs, nuxt, sveltekit, remix /
react-router, solidstart, tanstack-start, marko, stencil, vitepress,
docusaurus. Adapters that merely proxy an upstream CLI must say so in their
row rather than pose as a lunx engine. *Done when:* every advertised adapter
passes dev + build + preview, or is removed from the advertised list.

**1.4 Library coverage, not just frameworks.** "Supports all frameworks and
libraries" currently means 7 frameworks. Add a resolution conformance suite:
CommonJS-only packages, ESM-only packages, dual packages, `exports` maps with
`require`/`import`/`browser` conditions, `#imports` subpaths, wasm, web
workers, CSS-in-JS. These are what actually break on a real app.
*Done when:* a fixture suite covers each case and passes.

## Phase 2 — Close the speed gap

**2.1 Build and verify the Rust engine.** It is the precondition for every
number above. Needs a toolchain in CI, `verify-native.mjs` wired to fail the
build when the binary is missing, and the JSX-runtime plus CommonJS-lowering
fixes from this session ported into `native/src` (they were only applied to
the JS fallback).

**2.2 Dev boot 2042 ms → under 500 ms.** It is also *scaling badly*: the same
lunx build boots in 1310 ms in a small app and 2042 ms in the arena app, whose
only difference is a large `node_modules`. Something walks `node_modules` at
startup. Find it, then profile boot the way the build was profiled.

**2.3 Build warm 1611 ms → under 600 ms.** Minify is single-threaded and
whole-bundle. Move per-module transform and minify onto a worker pool
(`getOptimalParallelism` already exists in the native surface) and persist
transforms by content hash across builds (`CacheStore` is already written).

**2.4 Bundle size to parity.** +4.4% against Vite, +8.5% against Bun.
Tree-shaking across the CommonJS factory wrappers is the gap.

Every change in this phase lands with a `npm run bench:arena` before/after.

## Phase 3 — Make it the easy choice

**3.1 Zero-config on a project that was not built for lunx.** `lunx dev` in an
existing Vite, CRA or Next app, with no config file.

**3.2 One-command migration** from a `vite.config` / `webpack.config` —
Vercel is promising a webpack config migrator for Turbopack in 2026; a tool
that claims all-in-one needs the same on-ramp.

**3.3 `lunx doctor` that earns its name.** Detect the failure modes this
session hit — native binding not loadable, stale lockfile, missing peer,
dangling workspace symlink — and print the fix.

**3.4 Errors that name the remedy.** Done for `@swc/core`, puppeteer and
rolldown; apply across the board.

## Order and gates

1.1 → 1.2 → 2.2 (the node_modules scaling bug, because it is a real
regression) → 1.3 → 1.4 → 2.1 → 2.3 → 2.4 → Phase 3.

Gates that must stay green on every commit: `npm run test:internal` (9 suites),
`npm run test:browser-matrix`, `npx tsc -p tsconfig.typecheck.json --noEmit`,
and `postbuild`'s dangling-import and undeclared-package checks.
