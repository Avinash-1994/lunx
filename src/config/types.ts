/**
 * Lunx — Discriminated Union Config Types
 *
 * Provides framework-specific IntelliSense via defineConfig overloads.
 * Use `defineConfig()` to get full type-checking and hover documentation.
 *
 * @example Minimal React app (framework auto-detected from package.json)
 * ```ts
 * // lunx.config.ts
 * export default {}  // zero config — lunx detects React automatically
 * ```
 *
 * @example Explicit config
 * ```ts
 * import { defineConfig } from 'lunx'
 * export default defineConfig({
 *   framework: 'react',
 *   entry: 'src/main.tsx',
 *   outDir: 'dist',
 * })
 * ```
 */

// ─── Base (shared by all) ──────────────────────────────────────────────────

export interface LunxBaseConfig {
  /**
   * Entry point(s) for the build.
   *
   * **Auto-detected** when omitted — lunx scans for:
   * `index.html` → `src/main.tsx` → `src/main.ts` → `src/main.jsx` → `src/main.js`
   *
   * @example Single entry
   * ```ts
   * entry: 'src/main.tsx'
   * ```
   * @example Multiple entries (code splitting)
   * ```ts
   * entry: ['src/client.ts', 'src/admin.ts']
   * ```
   */
  entry?: string | string[];

  /**
   * Output directory for the build artifacts.
   * @default 'dist'
   */
  outDir?: string;

  /**
   * Build mode. Affects optimisations, source maps, and dead-code elimination.
   * - `'development'` — fast builds, full source maps, no minification
   * - `'production'`  — minified, tree-shaken, optimised for deployment
   * - `'test'`        — Jest/Vitest-friendly, no bundling
   * @default 'development'
   */
  mode?: 'development' | 'production' | 'test';

  /**
   * Dev server port.
   * @default 5173
   */
  port?: number;

  /**
   * Project root directory (where `package.json` lives).
   * @default process.cwd()
   */
  root?: string;

  /**
   * Public base path. Prepended to all asset URLs.
   * @default '/'
   * @example '/my-app/'  // for GitHub Pages sub-path deployment
   */
  base?: string;

  /**
   * Directory containing static assets served as-is.
   * @default 'public'
   */
  publicDir?: string;

  /**
   * Cache directory for build artefacts (SQLite WAL).
   * @default '.lunx/cache'
   */
  cacheDir?: string;

  /**
   * Lunx plugins. Compatible with the Lunx plugin API.
   * @example
   * ```ts
   * import lunxReact from '@lunx/plugin-react'
   * plugins: [lunxReact()]
   * ```
   */
  plugins?: any[];

  /**
   * CSS configuration.
   */
  css?: {
    /**
     * CSS framework integration.
     * @default 'none'
     */
    framework?: 'tailwind' | 'bootstrap' | 'bulma' | 'material' | 'none';
    /** Remove unused CSS rules in production builds. @default false */
    purge?: boolean;
    /** Extract and inline critical CSS. @default false */
    critical?: boolean;
  };

  /**
   * Production build options.
   */
  build?: {
    /** Minify output. @default true (production), false (development) */
    minify?: boolean;
    /**
     * Source map strategy.
     * - `'inline'`   — embedded in the JS file (large files, easy debugging)
     * - `'external'` — separate `.map` files (recommended for production)
     * - `'hidden'`   — generates maps but doesn't reference them in source
     * - `'none'`     — no source maps
     * @default 'external' (production), 'inline' (development)
     */
    sourcemap?: 'inline' | 'external' | 'hidden' | 'none' | boolean;
    /** Enable code splitting. @default true */
    splitting?: boolean;
    /** Enable CSS Modules. @default false */
    cssModules?: boolean;
    /**
     * Browser targets for transpilation.
     * @example ['chrome90', 'firefox88', 'safari14']
     */
    targets?: string[];
    /**
     * Manual chunk grouping (advanced).
     * @example { vendor: ['react', 'react-dom'] }
     */
    manualChunks?: Record<string, string[]>;
  };

  /**
   * Dev server configuration.
   */
  server?: {
    /** Bind address. Set to `'0.0.0.0'` to expose on the network. @default 'localhost' */
    host?: string;
    /** Port (overrides top-level `port`). @default 5173 */
    port?: number;
    /** Fail if port is already in use instead of trying the next one. @default false */
    strictPort?: boolean;
    /** Enable CORS. @default false */
    cors?: boolean;
    /** Auto-open browser on start. Pass a path string to open a specific URL. @default false */
    open?: boolean | string;
    /** Proxy rules for API requests. @example { '/api': 'http://localhost:3001' } */
    proxy?: Record<string, string | any>;
    /** Enable HTTPS. Pass `{ key, cert }` to use custom certificates. */
    https?: boolean | { key: string; cert: string };
    /** Custom response headers. */
    headers?: Record<string, string>;
  };

  /**
   * Security scanning options.
   */
  security?: {
    /**
     * Minimum CVE severity that blocks the build.
     * Set to `'off'` to disable scanning.
     * @default 'high'
     */
    vulnSeverity?: 'critical' | 'high' | 'medium' | 'low' | 'off';
    scan?: { allowlist?: string[] };
  };

  /**
   * Module Federation configuration (Webpack 5-compatible syntax).
   */
  federation?: {

    name:          string;
    filename?:     string;
    singletonHost?: string;
    exposes?:      Record<string, string>;
    remotes?:      Record<string, string>;
    shared?:       Record<string, { singleton?: boolean; requiredVersion?: string }>;
    prefetch?:     string[];
    fallback?:     string;
    mock?:         boolean;
    healthCheck?:  string;
  };
}

// ─── SSR Meta-Frameworks ───────────────────────────────────────────────────

export interface LunxSSRConfig extends LunxBaseConfig {
  framework: 'nuxt' | 'sveltekit' | 'svelte-kit' | 'remix' | 'solidstart'
           | 'solid-start' | 'astro' | 'analog' | 'tanstack-start' | 'waku'
           | 'next' | 'nextjs';
  preset?:    'ssr';
  platform?:  'node' | 'edge';
  ssrEntry?:  string;
}

// ─── Electron — dual bundle ────────────────────────────────────────────────

export interface LunxElectronConfig extends LunxBaseConfig {
  framework:      'electron';
  preset?:        'spa';
  platform?:      'browser';
  mainEntry?:     string; // default: src/main/index.ts
  rendererEntry?: string; // default: src/renderer/index.ts
  preloadEntry?:  string; // default: src/preload/index.ts
  ipcTypes?:      { output: string };
}

// ─── Tauri — WebView frontend ──────────────────────────────────────────────

export interface LunxTauriConfig extends LunxBaseConfig {
  framework: 'tauri';
  preset?:   'spa';
  platform?: 'browser';
  tauriSrc?: string; // default: src-tauri/
  ipcTypes?: { output: string };
}

// ─── SPA frameworks ───────────────────────────────────────────────────────

export interface LunxSPAConfig extends LunxBaseConfig {
  framework?: 'react' | 'vue' | 'svelte' | 'angular' | 'solid'
            | 'preact' | 'lit' | 'qwik' | 'vanilla';
  preset?:    'spa';
  platform?:  'browser';
}

// ─── defineConfig overloads ────────────────────────────────────────────────
/* eslint-disable no-redeclare */
export function defineConfig(c: LunxElectronConfig): LunxElectronConfig;
export function defineConfig(c: LunxTauriConfig):    LunxTauriConfig;
export function defineConfig(c: LunxSSRConfig):      LunxSSRConfig;
export function defineConfig(c: LunxSPAConfig):      LunxSPAConfig;
export function defineConfig(c: LunxBaseConfig):     LunxBaseConfig;
export function defineConfig(c: any): any { return c; }
/* eslint-enable no-redeclare */
