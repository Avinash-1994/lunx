# ⚡ Lunx

> **One tool for web apps: dev server, production bundler, test runner, type check, security — for any framework.**
> Builds on [Rolldown](https://rolldown.rs) and [Oxc](https://oxc.rs) (Rust) with LightningCSS for CSS; the dev server compiles on demand with the same compilers.
> Verified on 17 stacks in a real browser (React, Preact, Vue, Svelte, Solid, Lit, Angular, Alpine, Mithril, jQuery, three.js, Tailwind, styled-components, React Router, Vue Router, Sass, vanilla TS) — `npm run test:browser-matrix`.
> Runs existing Vite and Create React App projects unchanged — see [Migrating](#-migrating-to-lunx).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## 📖 Table of Contents

- [Quickstart Tutorial](#-quickstart-tutorial)
- [Framework Setup Guides](#-framework-setup-guides)
  - [React SPA](#1-react-spa)
  - [Vue 3](#2-vue-3)
  - [Svelte](#3-svelte)
  - [SolidJS](#4-solidjs)
  - [Angular](#5-angular)
  - [SSR / meta-frameworks](#6-ssr--meta-frameworks)
  - [Desktop Apps (Electron & Tauri)](#7-desktop-apps-electron--tauri)
- [Configuration & Auto-Detection](#-configuration--auto-detection)
- [Module Federation Tutorial](#-module-federation-tutorial)
- [Library Mode](#-library-mode)
- [Server, Edge and SSR Builds](#%EF%B8%8F-server-edge-and-ssr-builds)
- [Built-in Security CLI Suite](#-built-in-security-cli-suite)
- [Plugins](#-plugins)
- [Performance Benchmarks](#-performance-benchmarks)
- [Migrating to Lunx](#-migrating-to-lunx)
  - [From Vite](#migrating-from-vite)
  - [From Webpack](#migrating-from-webpack)
- [CLI Command Reference](#-cli-command-reference)
- [License](#-license)

---

## 🚀 Quickstart Tutorial

### Step 1 — Create a project

```bash
npx lunx-dev create my-app                      # pick a template
npx lunx-dev create my-app --template react     # or name it
```

Templates (all built, served and opened in a browser by `npm run test:templates`):

| | Templates |
|---|---|
| Apps | `react` `vue` `svelte` `solid` `preact` `lit` `alpine` `angular` `qwik` `vanilla` — TypeScript, or JavaScript with `--no-ts`; most take `--tailwind` |
| Frameworks | `next` `nuxt` `sveltekit` `astro` `react-router` `tanstack-start` `solidstart` `qwik-city` `vitepress` `waku` `analog` `remix` `docusaurus` `marko-run` |
| Other | `library` (npm package with `lunx build --lib`), `edge` (fetch handler for edge runtimes), `electron` (desktop app: React renderer, main process and preload) |

### Step 2 — Start the dev server

```bash
cd my-app
npm install
npm run dev
```

Edit any file in `src/`: the change is in the browser in tens of milliseconds, with component state kept for React, Vue, Svelte, Solid and Preact.

### Step 3 — Build and preview

```bash
npm run build      # dist/: minified, tree-shaken, .gz/.br copies, SBOM, SRI
npm run preview    # serve dist/ locally
```

### Adding lunx to an existing project

```bash
npm install -D lunx-dev
npx lunx dev
```

No config file is needed: lunx detects the framework from `package.json` and the entry from `index.html` (or `src/main.*`). An existing `vite.config.*` is read as it is — see [Migrating](#-migrating-to-lunx).

---

## 🛠 Framework Setup Guides

Each framework works with a `package.json` dependency and an `index.html`; `lunx create --template <name>` writes the files below.

### 1. React SPA

```bash
npm install react react-dom
npm install -D lunx-dev typescript @types/react @types/react-dom
```

```
├── index.html          <script type="module" src="/src/main.tsx"></script>
├── src/
│   ├── main.tsx
│   └── App.tsx
└── lunx.config.ts      optional
```

React Fast Refresh is built in; `@vitejs/plugin-react` is not needed.

---

### 2. Vue 3

```bash
npm install vue
npm install -D lunx-dev
```

```vue
<!-- src/App.vue -->
<script setup>
import { ref } from 'vue';
const count = ref(0);
</script>

<template>
  <button @click="count++">count is {{ count }}</button>
</template>
```

Single File Components, `<script setup>` (TypeScript too), scoped CSS and CSS modules work without plugins.

---

### 3. Svelte

```bash
npm install -D lunx-dev svelte
```

Svelte 5 components (runes, `<script lang="ts">`) compile with Svelte's own compiler; state is kept on hot updates.

---

### 4. SolidJS

```bash
npm install solid-js
npm install -D lunx-dev babel-preset-solid @babel/core
```

Solid's JSX compiles with its Babel preset (`babel-preset-solid`) to fine-grained updates. Lunx detects Solid from `package.json`; to be explicit:

```typescript
// lunx.config.ts
import { defineConfig } from 'lunx-dev';

export default defineConfig({ framework: 'solid' });
```

---

### 5. Angular

```bash
npm install @angular/core @angular/common @angular/compiler @angular/platform-browser rxjs tslib
npm install -D lunx-dev typescript @angular/compiler-cli
```

Standalone components with `templateUrl` / `styleUrl` and signals; `lunx create --template angular` writes a zoneless starter. With `@angular/compiler-cli` installed, `lunx build` compiles ahead of time as `ng build` does (the project's Angular compiler, Angular's linker for libraries, Angular's build optimizations), so the runtime template compiler is not shipped: the starter's bundle is 31.7 kB gzip against 31.9 kB from `ng build` (281 kB compiled at runtime), built in 3.8 s cold against 4.9 s. `lunx dev` compiles at runtime (JIT). Angular projects built with the Angular CLI keep using it, or use [Analog](https://analogjs.org) (`--template analog`), which lunx builds.

---

### 6. SSR / meta-frameworks

`lunx dev` and `lunx build` in a meta-framework project build it with lunx's own engine: its plugin host runs the framework's Vite plugins on Rolldown/Oxc, with no Vite, Rollup or vite-node code (each framework's own compiler, such as Svelte's or Angular's, still compiles its components).

| Framework | `lunx dev` / `lunx build` |
|---|---|
| SvelteKit, React Router (framework), Remix, TanStack Start, Qwik City, Astro, Nuxt, SolidStart, VitePress, Waku, Marko Run, Analog | **Built by lunx** (`[lunx] X project → built by lunx`) |
| Next.js, Docusaurus, Gatsby, RedwoodJS, Stencil | Run on the framework's own CLI and bundler, labelled as such in the output (`[lunx] X project → next build`) |

Set `LUNX_PLUGIN_HOST=0` to use a framework's own CLI instead. `npm run test:meta` checks every framework above in dev and build (reports/META_MATRIX.json).

---

### 7. Desktop Apps (Electron & Tauri)

#### Electron
lunx builds Electron apps itself, with no plugin and nothing to configure. `npx lunx-dev create my-app --template electron` sets up a React renderer, `electron/main.ts` and `electron/preload.ts`. Any project with `electron` installed and an `electron/main.*` gets the same:

- `lunx dev` serves the renderer with HMR, builds the main process and the preload into `dist-electron/`, and starts Electron with the dev server's URL in `LUNX_DEV_SERVER_URL` (also `VITE_DEV_SERVER_URL`). An edit to the main process restarts Electron; an edit to the preload reloads the window. Quitting the app ends `lunx dev`.
- `lunx build` writes the renderer to `dist/` with relative URLs (Electron loads it from disk), and, in parallel, the main process (`dist-electron/main.js`, ESM or CommonJS like the package; `dependencies` stay external) and the preload (`dist-electron/preload.cjs`, one CommonJS file, which sandboxed preloads require). `package.json` `main` points at `dist-electron/main.js`, ready for electron-builder or Electron Forge.
- `lunx preview` starts the build in Electron.
- Other entries or output folder: `electron: { main, preload, outDir }` in lunx.config; `electron: false` turns it off. `LUNX_ELECTRON_ARGS="--inspect=5858"` passes switches to Electron.

An existing Vite + `vite-plugin-electron` project runs on lunx unchanged; lunx leaves Electron to the plugin. `npm run test:templates` builds both starters and checks them in Electron: the window, the counter and the preload, after `lunx preview`, after `lunx dev`, and after a main-process edit restarts it.

#### Tauri
With `@tauri-apps/api` in `package.json`, lunx builds the web frontend for Tauri's WebView (set `devUrl` / `frontendDist` in `tauri.conf.json` to lunx's dev server and `dist/`); the Rust side in `src-tauri/` builds with the Tauri CLI.

---

## ⚙️ Configuration & Auto-Detection

### Zero-Config Mode
If your project has a standard layout, **you don't even need a `lunx.config.ts` file**. 

Lunx automatically:
1. **Detects your framework** from `dependencies` in `package.json`.
2. **Finds your entry point** by checking `index.html` → `src/main.tsx` → `src/main.ts` → `src/main.jsx` → `src/main.js`.
3. **Sets the output directory** to `dist/`.

### Custom Configuration (`lunx.config.ts`)

For custom builds, create a `lunx.config.ts` file and wrap it with `defineConfig` for full TypeScript auto-completion:

```typescript
import { defineConfig } from 'lunx-dev';

export default defineConfig({
  // Framework auto-detect overrides
  framework: 'react',
  
  // Custom entry points
  entry: ['src/main.tsx', 'src/admin.tsx'],
  
  // Output configuration
  outDir: 'dist',
  
  // Dev server settings
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': 'http://localhost:8080'
    }
  },
  
  // Production build options
  build: {
    minify: true,
    sourcemap: 'external',
    // Browsers to compile JS and CSS for (default: the project's browserslist,
    // else Vite's 'baseline-widely-available'); 'esnext' keeps syntax as written
    target: ['chrome90', 'firefox88', 'safari14'],
    // .vite/manifest.json for server-rendered backends (Laravel, Rails, Django…)
    manifest: true,
    // Third-party license notices: 'linked' (default: <chunk>.LICENSE.txt), 'inline' or 'none'
    legalComments: 'linked',
  },

  // Share compile results between machines (CI, teammates): 'http' or 's3'
  cache: {
    remote: { provider: 'http', baseUrl: 'https://cache.example.com/lunx', token: process.env.CACHE_TOKEN },
  },

  // Supply-chain security settings
  security: {
    vulnSeverity: 'high' // 'critical' | 'high' | 'medium' | 'low' | 'off'
  }
});
```

---

## 🌐 Module Federation Tutorial

Lunx features native support for **Module Federation** (Webpack 5 syntax), enabling Micro-Frontend architectures without complex setup.

### Host Application (`lunx.config.ts`)

```typescript
import { defineConfig } from 'lunx-dev';

export default defineConfig({
  framework: 'react',
  port: 3000,
  federation: {
    name: 'hostApp',
    remotes: {
      navRemote: 'http://localhost:3001/remoteEntry.js'
    },
    shared: {
      react: { singleton: true },
      'react-dom': { singleton: true }
    }
  }
});
```

### Remote Application (`lunx.config.ts`)

```typescript
import { defineConfig } from 'lunx-dev';

export default defineConfig({
  framework: 'react',
  port: 3001,
  federation: {
    name: 'navRemote',
    filename: 'remoteEntry.js',
    exposes: {
      './Header': './src/components/Header.jsx',
      './Footer': './src/components/Footer.jsx'
    },
    shared: {
      react: { singleton: true },
      'react-dom': { singleton: true }
    }
  }
});
```

### Consuming Remote Component in Host

```tsx
import React, { lazy, Suspense } from 'react';
import { formatPrice } from 'navRemote/utils';      // static imports work too

const RemoteHeader = lazy(() => import('navRemote/Header'));

export function App() {
  return (
    <div>
      <Suspense fallback={<div>Loading Header...</div>}>
        <RemoteHeader />
      </Suspense>
      <main>Host Application Body {formatPrice(10)}</main>
    </div>
  );
}
```

### How it works

- `remoteEntry.js` is an ES module exporting the webpack 5 container API (`init`, `get`); `mf-manifest.json` lists exposes, shared versions and CSS. Remotes can be lunx ES module containers or webpack containers (`name@url` with a global).
- **Shared** packages go through a webpack-format share scope: `singleton`, `requiredVersion` (defaults to your package.json range), `strictVersion` and `eager`. Each app's own copy is a separate chunk, downloaded only if the scope picks it, so a remote using the host's React never fetches its own.
- **Dev and build mix freely**: a dev host can load a built remote and the other way round. In dev, a remote's modules fast-refresh inside the host page, state kept.
- **Types across apps**, in `@module-federation`'s format (so lunx, webpack and Rspack apps read each other's): a TypeScript remote's build writes `@mf-types.zip` beside `remoteEntry.js` (its dev server serves it too), and a host downloads each remote's into `@mf-types/<remote>/` when it starts or builds. Add `"paths": { "*": ["./@mf-types/*"] }` to the host's tsconfig and `import Button from 'remote/Button'` is typed. `federation: { dts: false }` turns it off, `{ generateTypes, consumeTypes }` picks a side.
- `npm run test:federation-e2e` runs all four dev/build pairings in Chromium.
- **With webpack 5 and Rspack**, both ways (`npm run test:mf-interop`, production builds in Chromium, React shared as a singleton): a lunx host loads their remotes as `name@url`; their hosts load a lunx remote, an ES module, with `remoteType: 'import'` (or `'import <url>'` beside script remotes) and, for webpack, `target: ['web', 'es2020']`. A shell mixing lunx, webpack and Rspack remotes shares one React across all of them.

---

## 📦 Library Mode

`lunx build --lib` builds a package for npm instead of an app:

```bash
npx lunx build --lib src/index.ts                 # ES + CommonJS + .d.ts
npx lunx build --lib --formats es,umd --name MyLib # adds a <script> global build
```

or in `lunx.config.ts` (a `vite.config` `build.lib` is read the same way):

```typescript
export default defineConfig({
  lib: {
    entry: { index: 'src/index.ts', utils: 'src/utils/index.ts' },
    formats: ['es', 'cjs'],
  },
});
```

- `dependencies`, `peerDependencies` and Node built-ins stay imports; devDependencies and your sources are bundled (`external` / `noExternal` adjust it).
- Vue and Svelte components and Solid / Preact JSX compile as in app builds; CSS, Sass, Less and CSS modules are extracted to `style.css`; assets are inlined.
- `.d.ts` files come from Oxc's isolated declarations in milliseconds, or from `tsc` when an export has no explicit type.
- The build checks that package.json `main`, `module`, `types` and `exports` point at files it wrote, and suggests an `exports` map when they do not.

---

## 🖥️ Server, Edge and SSR Builds

```typescript
export default defineConfig({ platform: 'node' });   // or 'edge'
export default defineConfig({ preset: 'ssr', entry: ['src/entry-server.tsx'] });
```

- `platform: 'node'` bundles the server entry (`entry`, or `src/server.ts`, `src/entry-server.tsx`, `src/index.ts`…) as an ES module; `dependencies` stay in `node_modules`.
- `platform: 'edge'` bundles every dependency too, for Workers-style runtimes with no `node_modules`, resolving `workerd` / `worker` / `edge-light` exports.
- `preset: 'ssr'` builds the page into `dist/browser` and the server entry into `dist/node`.

All three run on the same Rolldown engine as app builds.

---

## 🛡️ Built-in Security CLI Suite

Lunx includes an integrated security scanner. Before every production build, Lunx scans your code and dependencies. If a secret (API key, token, private key) is detected in source, **the build aborts before writing to `dist/`**.

```bash
# Run the complete security audit
lunx security audit

# Scan source code for leaked credentials/tokens
lunx security scan

# Check dependencies against OSV vulnerability database
lunx security cve

# Generate CycloneDX 1.5 Software Bill of Materials (SBOM)
lunx security sbom

# Auto-generate Content Security Policy (CSP) headers for Nginx / Netlify / Vercel
lunx security headers

# Automatically upgrade vulnerable dependencies
lunx security fix

# Audit plugin permissions
lunx security plugins

# Generate full HTML / JSON security report
lunx security report
```

---

## 🔌 Plugins

Vite and Rollup plugins go in `plugins` (in `lunx.config.ts`, or an existing `vite.config.*`; with both, `lunx.config` applies on top of the Vite config) and run with Vite's lifecycle in dev and in the build: `apply`, `enforce`, `config`, `configResolved`, `resolveId` / `load` / `transform` (virtual modules included), `transformIndexHtml`, `configureServer`, `renderChunk`, `generateBundle`, `writeBundle` and `closeBundle` (once the whole app is on disk). Plugins that import `vite` get lunx's stand-in, so Vite does not need to be installed. Framework projects (SvelteKit, Nuxt, Astro, React Router…) run on lunx's Vite-compatible plugin host. esbuild plugins in `optimizeDeps.esbuildOptions.plugins` run in the dependency optimizer.

`npm run test:vite-plugins` builds, previews and runs on the dev server, in Chromium, a React app with each of: `vite-plugin-pwa`, `@tailwindcss/vite`, `unocss`, `vite-plugin-svgr`, `vite-tsconfig-paths`, `unplugin-auto-import`, `unplugin-icons`, `vite-plugin-html`, `vite-plugin-static-copy`, `rollup-plugin-visualizer`, `@mdx-js/rollup`, `vite-plugin-glsl`, `vite-imagetools`, `vite-plugin-wasm`, `vite-plugin-node-polyfills`, `vite-plugin-checker` and `vite-plugin-inspect`, then the built-ins below with no plugin installed ([report](reports/VITE_PLUGINS_MATRIX.json)). Not supported: `@vitejs/plugin-legacy`, whose legacy chunks need a SystemJS build that Rolldown does not write.

```typescript
import { defineConfig } from 'lunx-dev';

export default defineConfig({
  plugins: [
    {
      name: 'banner',
      transform(code, id) {
        if (id.endsWith('/src/main.ts')) return `console.log('built ${new Date().toISOString()}');\n${code}`;
      },
    },
  ],
});
```

### Built in: no plugin needed

| You'd install | lunx has it built in |
|---|---|
| `@vitejs/plugin-react`, `@vitejs/plugin-vue`, `@sveltejs/vite-plugin-svelte`, `vite-plugin-solid`, `@preact/preset-vite` | Framework compilers (Oxc, Vue, Svelte, Solid) |
| `vite-plugin-svgr`, `vite-svg-loader` | `import Logo from './logo.svg?react'` (React, Preact) or `?component` (React, Preact, Vue): the root `<svg>`'s attributes are props you can override |
| `vite-plugin-wasm` (for `?init`) | `import init from './module.wasm?init'`, then `const instance = await init(imports)`, as in Vite |
| `vite-tsconfig-paths` | `compilerOptions.paths` from `tsconfig.json` / `jsconfig.json` |
| `vite-plugin-electron` | Electron apps ([above](#electron)) |
| `rollup-plugin-visualizer` | `lunx analyze` |
| `vite-plugin-checker` | `server: { typecheck: true }`: `lunx dev` runs your TypeScript (`vue-tsc` in Vue projects that have it) in watch mode and lists type errors in the terminal and in the overlay's Type Errors tab |
| `vite-plugin-pwa` | `pwa: { manifest: { name, short_name, icons… } }` in lunx.config: `manifest.webmanifest`, a service worker that precaches the build (cache-first, offline navigations fall back to `index.html`, old caches dropped on deploy) and its registration, linked from every page |
| — | `%VITE_APP_TITLE%`, `%MODE%`… (any `import.meta.env` value) in `index.html`, as in Vite |

An installed plugin still wins: with `vite-plugin-svgr` in the config, `?react` imports go to it; with `vite-plugin-pwa`, lunx writes no service worker.

TypeScript types for all of these (assets, `?raw`, `?url`, `?react`, `.wasm?init`, CSS modules, `import.meta.env`, `import.meta.hot`, `import.meta.glob`) come with lunx: `/// <reference types="lunx-dev/client" />` in a `.d.ts` file (the TypeScript starters have it in `src/lunx-env.d.ts`), or `"types": ["lunx-dev/client"]` in tsconfig.json.

Plugins that ask for permissions (`fs:write`, `env:read`, network) run in lunx's permission sandbox (`lunx security plugins`).

---

## 📊 Performance Benchmarks

Every tool installed from npm, same React + TypeScript app, median of 7 runs, all in one session on a Linux cloud container (`npx tsx scripts/bench-arena.mjs --hmr --runs 7 [--scale 2000]`; results in `reports/BENCH_ARENA*.json`). **HMR** is the time from saving `App.tsx` to Chromium showing the change. Compare ratios, not absolute times.

**Small app**

| Tool | Dev boot | App code ready | HMR | Build (cold) | Build (warm) | JS out |
|---|---|---|---|---|---|---|
| **lunx** | 229 ms | 234 ms | 39 ms | 341 ms | 322 ms | 221 KB |
| Vite 8 | 437 ms | 511 ms | 42 ms | 548 ms | 461 ms | 220 KB |
| Rspack | 378 ms | 409 ms | 188 ms | 323 ms | 368 ms | 219 KB |
| Parcel | 1317 ms | 1326 ms | 34 ms | 1640 ms | 1569 ms | 222 KB |
| webpack | 1599 ms | 1749 ms | 265 ms | 4009 ms | 3891 ms | 225 KB |
| esbuild (bundler only) | – | – | – | 63 ms | 56 ms | 223 KB |
| Bun (bundler only) | – | – | – | 38 ms | 39 ms | 212 KB |

**Large app: 2,000 components** (`--scale 2000`)

| Tool | Dev boot | App code ready | HMR | Build (cold) | Build (warm) | JS out |
|---|---|---|---|---|---|---|
| **lunx** | 250 ms | 255 ms | 161 ms | 626 ms | 545 ms | 470 KB |
| Vite 8 | 400 ms | 706 ms | 178 ms | 918 ms | 718 ms | 470 KB |
| Rspack | 693 ms | 829 ms | 677 ms | 823 ms | 842 ms | 493 KB |
| Parcel | 4855 ms | 4895 ms | 189 ms | 5358 ms | 5143 ms | 455 KB |
| webpack | 4374 ms | 4608 ms | 1165 ms | 9115 ms | 8860 ms | 516 KB |
| esbuild (bundler only) | – | – | – | 141 ms | 148 ms | 493 KB |
| Bun (bundler only) | – | – | – | 92 ms | 97 ms | 430 KB |

**Build output against Vite 8** (same app per framework, both built and run in Chromium; `npm run test:parity`, `reports/OUTPUT_PARITY.json`). Each app has a component with state, global CSS, a CSS module, an emitted image, a JSON named import, a lazy chunk, a worker, an env value and dev-only code; the `app` row adds two pages, base `/sub/`, source maps, lazy routes with their own CSS, CSS `@import` / `url()` and `public/`. Every probe passes for both tools.

| JS, gzip | vanilla | React | Preact | Vue | Svelte | Solid | Lit | app |
|---|---|---|---|---|---|---|---|---|
| **lunx** | 0.6 KB | 66.7 KB | 5.8 KB | 24.8 KB | 10.1 KB | 4.3 KB | 6.2 KB | 67.6 KB |
| Vite 8 | 1.5 KB | 67.2 KB | 6.7 KB | 24.9 KB | 10.9 KB | 5.3 KB | 7.0 KB | 68.1 KB |

**Meta-frameworks against their own CLI** (the client build, JS gzip; `npm run test:meta-parity`, `reports/META_PARITY.json`): SvelteKit 27.7 vs 30.2 KB, Nuxt 53.8 vs 53.5, React Router 93.9 vs 96.7, Remix 80.9 vs 83.4, VitePress 52.7 vs 55.6, SolidStart 16.8 vs 17.6, Waku 84.1 vs 83.5, TanStack Start 96.8 vs 101.0, Qwik City 35.5 vs 36.0, Analog 67.3 vs 70.4 (Astro and Marko Run pages ship no JS with either). Next.js and Docusaurus run their own CLI under lunx.

CSS is within a few bytes of Vite's in every app, and CSS that only lazy chunks import loads with them (`build.cssCodeSplit: false` for one file). Vite's extra kilobyte in the small apps is its modulepreload polyfill, which lunx leaves out (every browser that runs ES modules supports modulepreload).

Where lunx is behind: esbuild and Bun bundle several times faster, though without a dev server, HMR or framework support; on the small app Rspack's cold build (323 vs 341 ms) and Parcel's HMR (34 vs 39 ms) are within run-to-run noise (±30% on shared cores) of lunx's. `lunx build` also writes gzip/brotli copies, an SBOM and SRI/CSP data and checks the lockfile and known CVEs, which the others do not; the checks run while Rolldown is still minifying. Vue / Svelte projects with 100+ components compile on worker threads (`LUNX_COMPILE_WORKERS=0` turns it off).

---

## 🔄 Migrating to Lunx

### From Vite — zero changes

Install lunx and run it in the project as it is:

```bash
npm install -D lunx-dev
npx lunx dev      # reads vite.config.* when there is no lunx.config
npx lunx build
```

Lunx evaluates your `vite.config.*` and maps `base`, `define`, `resolve.alias`,
`server.*`, `build.outDir`, `build.sourcemap` and `build.rollupOptions.input`.
Framework plugins (`@vitejs/plugin-react`, `plugin-vue`, `vite-plugin-svelte`,
`vite-plugin-solid`, `@preact/preset-vite`, Analog) are replaced by lunx's
built-in compilers; other plugins are Rollup-compatible and run in the build.
`import.meta.env.VITE_*`, `import.meta.glob`, `?raw` / `?url` / `?inline`,
`new URL('./x', import.meta.url)`, workers, wasm and PostCSS/Tailwind work as
they do in Vite.

To convert permanently:

```bash
npx lunx migrate        # writes lunx.config.ts, points package.json scripts at lunx
```

### From Create React App

```bash
npx lunx migrate        # index.html from public/, lunx.config.ts, scripts
```

`REACT_APP_*` variables, JSX in `.js` files, CSS Modules and SVG/image imports
keep working.

### From webpack

1. Remove `webpack.config.js`, `babel.config.js` and the loaders.
2. Make sure `index.html` at the project root loads your entry:
   `<script type="module" src="/src/main.tsx"></script>`.
3. Update scripts to `lunx dev` / `lunx build`. `resolve.alias` and tsconfig
   `paths` are honoured; add aliases to `lunx.config.ts` if you used webpack's.

---

## 💻 CLI Command Reference

| Command | Action |
|---|---|
| `lunx dev` | Start development server with HMR |
| `lunx build` | Create minified production build with security scan |
| `lunx build --lib [entry]` | Build a library: ES/CJS (`--formats es,cjs,umd,iife`, `--name`), `.d.ts`, `--watch` |
| `lunx build --force` | Rebuild even when nothing changed (builds are cached in `.lunx/`) |
| `lunx preview` | Serve production build locally for verification |
| `lunx create [name]` | Scaffold a project: interactive, or `--template <name>` with `--no-ts` / `--tailwind` |
| `lunx migrate` | Auto-migrate project configuration |
| `lunx check` | Run TypeScript typecheck & circular dependency detection |
| `lunx doctor` | Run environment and project health diagnostics |
| `lunx security` | Execute the 8-command security audit suite |
| `lunx why <module>` | Print import chain leading to a specific module |
| `lunx info` | Print system & environment info for bug reports |

**Build cache.** `lunx build` skips the build when no project file, installed package, env var or option changed since the last one and the output is untouched, and caches framework compiler output (Vue, Svelte, Solid, JSX) so a rebuild recompiles only changed components. `--force` or `LUNX_BUILD_CACHE=0` bypass it; `build: { cache: false }` turns it off. `LUNX_TIMINGS=1` prints where build time goes.

---

## 📜 License

Distributed under the [MIT License](LICENSE). Copyright © 2026 Avinash-1994 & Lunx Contributors.
