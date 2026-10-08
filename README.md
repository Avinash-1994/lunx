# ⚡ Lunx

> **One tool for web apps: dev server, production bundler, test runner, type check, security — for any framework.**
> Production builds run on [Rolldown](https://rolldown.rs) (Rust); dev runs on SWC + LightningCSS with an optional Rust engine (`@lunx/native-*`).
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
  - [Svelte 5 / Svelte 4](#3-svelte)
  - [SolidJS](#4-solidjs)
  - [Angular (v2–v18+)](#5-angular)
  - [SSR / meta-frameworks](#6-ssr--meta-frameworks)
  - [Desktop Apps (Electron & Tauri)](#7-desktop-apps-electron--tauri)
- [Configuration & Auto-Detection](#-configuration--auto-detection)
- [Module Federation Tutorial](#-module-federation-tutorial)
- [Library Mode](#-library-mode)
- [Server, Edge and SSR Builds](#%EF%B8%8F-server-edge-and-ssr-builds)
- [Built-in Security CLI Suite](#-built-in-security-cli-suite)
- [Official Plugins](#-official-plugins)
- [Performance Benchmarks](#-performance-benchmarks)
- [Migrating to Lunx](#-migrating-to-lunx)
  - [From Vite](#migrating-from-vite)
  - [From Webpack](#migrating-from-webpack)
- [CLI Command Reference](#-cli-command-reference)
- [License](#-license)

---

## 🚀 Quickstart Tutorial

You can get a project running with Lunx in under **60 seconds**.

### Step 1 — Scaffold a Project

Use your preferred package manager:

```bash
# npm
npm create lunx@latest my-app

# pnpm
pnpm create lunx my-app

# bun
bun create lunx my-app

# yarn
yarn create lunx my-app
```

Follow the interactive prompts to choose your framework (React, Vue, Svelte, Solid, Angular, Vanilla) and language (TypeScript / JavaScript).

### Step 2 — Start the Dev Server

```bash
cd my-app
npm install
npm run dev
```

You will see the dev server startup banner:
```
⚡ Lunx v1.0.0 — Dev Server
  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.10:5173/

  ✔ Ready in 18ms (HMR active)
```

Edit any file in `src/` — changes hot-reload via the native watcher and SWC transform when the Rust binary is loaded.

### Step 3 — Production Build & Preview

```bash
# Build for production
npx lunx build

# Preview the dist/ output locally
npx lunx preview
```

Your production bundle will be created in `./dist/`, minified, tree-shaken, and validated by Lunx's automated security scanner.

---

## 🛠 Framework Setup Guides

Lunx supports **16+ framework adapters** out of the box. No complex plugin assembly required.

### 1. React SPA

**Installation:**
```bash
npm install react react-dom
npm install -D lunx typescript @types/react @types/react-dom
```

**Project Structure:**
```
├── index.html
├── src/
│   ├── main.tsx
│   └── App.tsx
└── lunx.config.ts  (Optional - zero config auto-detects React)
```

**`index.html`:**
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Lunx React App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

---

### 2. Vue 3

**Installation:**
```bash
npm install vue
npm install -D lunx @vue/compiler-sfc
```

**`src/App.vue`:**
```vue
<script setup>
import { ref } from 'vue';
const count = ref(0);
</script>

<template>
  <button @click="count++">Count is: {{ count }}</button>
</template>
```

Lunx handles Single File Components (`.vue`), `<script setup>`, and scoped CSS automatically.

---

### 3. Svelte

**Installation:**
```bash
npm install svelte
npm install -D lunx svelte-preprocess
```

Lunx automatically compiles `.svelte` components with state preservation during hot module replacement.

---

### 4. SolidJS

**Installation:**
```bash
npm install solid-js
npm install -D lunx babel-preset-solid
```

**`lunx.config.ts`:**
```typescript
import { defineConfig } from 'lunx';

export default defineConfig({
  framework: 'solid'
});
```

---

### 5. Angular

Lunx features an AOT-compatible Angular compiler adapter supporting Angular v2 through v18+.

**`lunx.config.ts`:**
```typescript
import { defineConfig } from 'lunx';

export default defineConfig({
  framework: 'angular',
  entry: 'src/main.ts'
});
```

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
Dual-bundle compilation for Electron Main, Preload, and Renderer processes:
```typescript
// lunx.config.ts
import { defineConfig } from 'lunx';

export default defineConfig({
  framework: 'electron',
  mainEntry: 'src/main/index.ts',
  rendererEntry: 'src/renderer/index.tsx',
  preloadEntry: 'src/preload/index.ts'
});
```

#### Tauri
WebView-frontend compilation integrated with Rust Tauri apps:
```typescript
// lunx.config.ts
import { defineConfig } from 'lunx';

export default defineConfig({
  framework: 'tauri',
  tauriSrc: 'src-tauri/'
});
```

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
import { defineConfig } from 'lunx';

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
    splitting: true,
    targets: ['chrome90', 'firefox88', 'safari14']
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
import { defineConfig } from 'lunx';

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
import { defineConfig } from 'lunx';

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
- `npm run test:federation-e2e` runs all four dev/build pairings in Chromium.

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

## 🔌 Official Plugins

| Package | Purpose |
|---|---|
| `@lunx/plugin-env` | Injects `LUNX_` environment variables and generates `.d.ts` definitions |
| `@lunx/plugin-pwa` | Progressive Web App manifest generator & service worker compilation |
| `@lunx/plugin-icons` | On-demand icon loading (Material Design, FontAwesome, Tabler, etc.) |
| `@lunx/plugin-svg` | Import SVG files as URLs, raw strings, or React/Vue components |
| `@lunx/plugin-legacy` | Legacy browser polyfills via SWC downlevel compilation |
| `@lunx/plugin-compression` | Rust Brotli (69.5% reduction) + Gzip compression |
| `@lunx/plugin-auto-import` | Auto-inject component/utility imports with TypeScript declarations |
| `@lunx/plugin-inspect` | Visualise build dependency graph at `http://localhost:5173/__lunx_inspect__` |
| `@lunx/plugin-checker` | Async TypeScript typechecking & ESLint in worker threads |
| `@lunx/plugin-mock` | Built-in REST & GraphQL mock server |
| `@lunx/plugin-image` | Automatic AVIF / WebP conversion & responsive `srcset` generation |

---

## 📊 Performance Benchmarks

Every tool installed from npm, same React + TypeScript app, median of 5 runs, all in one session on a Linux cloud container (`npx tsx scripts/bench-arena.mjs --hmr [--scale 2000]`; results in `reports/BENCH_ARENA*.json`). **HMR** is the time from saving `App.tsx` to Chromium showing the change. Compare ratios, not absolute times.

**Small app**

| Tool | Dev boot | App code ready | HMR | Build (cold) | Build (warm) | JS out |
|---|---|---|---|---|---|---|
| **lunx** | 263 ms | 267 ms | 35 ms | 349 ms | 353 ms | 221 KB |
| Vite 8 | 401 ms | 486 ms | 42 ms | 448 ms | 533 ms | 220 KB |
| Rspack | 389 ms | 424 ms | 218 ms | 409 ms | 419 ms | 219 KB |
| Parcel | 1650 ms | 1662 ms | 33 ms | 1892 ms | 1858 ms | 222 KB |
| webpack | 1643 ms | 1773 ms | 292 ms | 4695 ms | 4586 ms | 225 KB |
| esbuild (bundler only) | – | – | – | 71 ms | 82 ms | 223 KB |
| Bun (bundler only) | – | – | – | 47 ms | 49 ms | 212 KB |

**Large app: 2,000 components** (`--scale 2000`)

| Tool | Dev boot | App code ready | HMR | Build (cold) | Build (warm) | JS out |
|---|---|---|---|---|---|---|
| **lunx** | 276 ms | 280 ms | 189 ms | 787 ms | 667 ms | 470 KB |
| Vite 8 | 396 ms | 755 ms | 194 ms | 869 ms | 716 ms | 470 KB |
| Rspack | 736 ms | 882 ms | 744 ms | 983 ms | 960 ms | 493 KB |
| Parcel | 5379 ms | 5410 ms | 256 ms | 5782 ms | 5930 ms | 455 KB |
| webpack | 4228 ms | 4465 ms | 1216 ms | 10269 ms | 10152 ms | 516 KB |
| esbuild (bundler only) | – | – | – | 179 ms | 183 ms | 493 KB |
| Bun (bundler only) | – | – | – | 110 ms | 99 ms | 430 KB |

Where lunx is behind: esbuild and Bun bundle several times faster, though without a dev server, HMR or framework support, and Parcel's HMR on the small app is within a few ms of lunx's (33 vs 35 ms). `lunx build` also writes gzip/brotli copies, an SBOM and SRI/CSP data and checks the lockfile and known CVEs, which the others do not; the checks run while Rolldown is still minifying. Vue / Svelte projects with 100+ components compile on worker threads (`LUNX_COMPILE_WORKERS=0` turns it off).

---

## 🔄 Migrating to Lunx

### From Vite — zero changes

Run lunx in the project as it is:

```bash
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
| `lunx create` | Interactive project scaffolding |
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
