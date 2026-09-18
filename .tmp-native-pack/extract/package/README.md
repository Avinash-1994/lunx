# ⚡ Lunx

> **A Rust-native JavaScript build tool for SPAs and Module Federation**, with SWC + LightningCSS, HMR, and built-in supply-chain security. Requires the shipped `lunx_native` binary (npm packages include it). JS fallback uses `@swc/core` and is slower.

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
  - [SSR / meta-frameworks (compat proxies)](#6-ssr-meta-frameworks)
  - [Desktop Apps (Electron & Tauri)](#7-desktop-apps-electron--tauri)
- [Configuration & Auto-Detection](#-configuration--auto-detection)
- [Module Federation Tutorial](#-module-federation-tutorial)
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

### 6. SSR / meta-frameworks (compat, not a replacement)

Lunx is an **SPA + Module Federation** build tool. It does **not** replace Next.js, Nuxt, SvelteKit, Remix, or similar SSR engines.

When those frameworks are detected, Lunx adapters **delegate to the upstream CLI** (for example spawning `next dev`) or apply limited Pages-router loader hooks. Treat them as compatibility shims:

| Framework | What Lunx does |
|---|---|
| **Next.js** | App Router: proxies `next dev`. Pages Router: optional SWC loader hook. Not a Next replacement. |
| **Nuxt / SvelteKit / Remix / SolidStart / …** | Detected and labeled as upstream adapters. Use each framework's own `dev`/`build`. |

For production speed, use Lunx on **React / Vue / Svelte / Solid / Preact SPAs** and federated remotes.

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

// @ts-ignore
const RemoteHeader = lazy(() => import('navRemote/Header'));

export function App() {
  return (
    <div>
      <Suspense fallback={<div>Loading Header...</div>}>
        <RemoteHeader />
      </Suspense>
      <main>Host Application Body</main>
    </div>
  );
}
```

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

Numbers below are **only valid when the native binary is loaded** (`[lunx] engine: rust-native` at startup). If you see `engine: js-fallback`, transforms run on `@swc/core` in Node and will be slower.

Reproduce locally via `cd benchmarks/public && node run-all.mjs` after `npm run build` on this repo.

| Benchmark Metric | Notes |
|---|---|
| **HMR** | Rust `notify` watcher + SWC transform when native is loaded. Published packages without `lunx_native*.node` fall back to chokidar + JS. Do not treat synthetic sub-millisecond lab numbers as a product claim. |
| **Cold / warm build** | Dominated by native SWC + LightningCSS on SPA graphs. Compare against Vite/Rspack on the same fixture; do not use unpublished internal benches as marketing. |

---

## 🔄 Migrating to Lunx

### Migrating from Vite

1. Rename `vite.config.js` / `vite.config.ts` to `lunx.config.ts`.
2. Replace `import { defineConfig } from 'vite'` with `import { defineConfig } from 'lunx'`.
3. In `package.json`, update scripts:
   ```diff
   - "dev": "vite",
   - "build": "vite build"
   + "dev": "lunx dev",
   + "build": "lunx build"
   ```

### Migrating from Webpack

1. Remove `webpack.config.js`, `babel.config.js`, `ts-loader`, `css-loader`, `style-loader`.
2. Create `lunx.config.ts`:
   ```typescript
   import { defineConfig } from 'lunx';

   export default defineConfig({
     // Lunx auto-handles JS/TS/JSX/TSX, CSS, images, and JSON natively
   });
   ```
3. Update package scripts to `lunx dev` and `lunx build`.

---

## 💻 CLI Command Reference

| Command | Action |
|---|---|
| `lunx dev` | Start development server with HMR |
| `lunx build` | Create minified production build with security scan |
| `lunx preview` | Serve production build locally for verification |
| `lunx create` | Interactive project scaffolding |
| `lunx migrate` | Auto-migrate project configuration |
| `lunx check` | Run TypeScript typecheck & circular dependency detection |
| `lunx doctor` | Run environment and project health diagnostics |
| `lunx security` | Execute the 8-command security audit suite |
| `lunx why <module>` | Print import chain leading to a specific module |
| `lunx info` | Print system & environment info for bug reports |

---

## 📜 License

Distributed under the [MIT License](LICENSE). Copyright © 2026 Avinash-1994 & Lunx Contributors.
