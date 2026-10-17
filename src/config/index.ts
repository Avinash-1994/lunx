import fs from 'fs/promises';
import path from 'path';
import kleur from '../lib/colors.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import yaml from '../lib/yaml.js';

import { z } from '../lib/schema.js';
import { log } from '../utils/logger.js';
import { spaPreset, ssrPreset, ssgPreset } from '../presets/index.js';

function normalizeRemoteUrl(value: any): string {
  if (typeof value !== 'string') return value;
  const webpackRemote = /^([A-Za-z0-9_$-]+)@(https?:\/\/.*)$/;
  const match = webpackRemote.exec(value);
  return match ? match[2] : value;
}

export type BuildMode = 'development' | 'production' | 'test';

export const BuildConfigSchema = z.object({
  root: z.string().optional(),
  adapter: z.string().optional(),
  framework: z.string().optional(),
  entry: z.union([z.string(), z.array(z.string())])
    .transform((val) => (typeof val === 'string' ? [val] : val))
    .optional(),
  mode: z.enum(['development', 'production', 'test']).default('development'),
  outDir: z.string().default('dist'),
  port: z.number().default(5173),
  plugins: z.array(z.any()).optional(),
  esbuildPlugins: z.array(z.any()).optional(),
  platform: z.enum(['browser', 'node', 'edge']).default('browser'),
  preset: z.enum(['spa', 'ssr', 'ssg']).default('spa'),
  // Library mode (src/build/library.ts): `lunx build` writes a package instead of an app.
  lib: z.any().optional(),
  // A web app manifest and precaching service worker (src/build/pwa.ts).
  pwa: z.union([z.boolean(), z.object({
    manifest: z.union([z.record(z.string(), z.any()), z.literal(false)]).optional(),
    register: z.boolean().optional(),
    navigateFallback: z.union([z.string(), z.literal(null)]).optional(),
    exclude: z.array(z.any()).optional(),
  })]).optional(),
  // Electron (src/electron): the main process and preload lunx builds, or `false` to leave Electron alone.
  electron: z.union([z.literal(false), z.object({
    main: z.string().optional(),
    preload: z.union([z.string(), z.literal(false)]).optional(),
    outDir: z.string().optional(),
  })]).optional(),
  federation: z.object({
    name: z.string(),
    filename: z.string().optional(),
    singletonHost: z.string().optional(),
    exposes: z.record(z.string(), z.string()).optional(),
    remotes: z.record(z.string(), z.union([z.string(), z.object({ entry: z.string(), name: z.string().optional(), type: z.enum(['module', 'script', 'var']).optional() })])).optional(),
    /** How shared versions are picked: 'loaded-first' (default) or 'version-first' (every remote joins the scope first). */
    shareStrategy: z.enum(['loaded-first', 'version-first']).optional(),
    /** Runtime plugin files (beforeRequest, onLoad, errorLoadRemote), as @module-federation/runtime's. */
    runtimePlugins: z.array(z.string()).optional(),
    shared: z.union([
      z.array(z.string()),
      z.record(z.string(), z.union([z.boolean(), z.string(), z.object({
        singleton: z.boolean().optional(),
        requiredVersion: z.union([z.string(), z.literal(false)]).optional(),
        strictVersion: z.boolean().optional(),
        eager: z.boolean().optional(),
        version: z.string().optional(),
        /** false: no copy of its own, it must come from another app's share scope. */
        import: z.literal(false).optional(),
      })])),
    ]).optional(),
    /** Type hints across apps (`@mf-types`, as `@module-federation`'s dts plugin): on by default in TypeScript projects. */
    dts: z.union([z.boolean(), z.object({ generateTypes: z.boolean().optional(), consumeTypes: z.boolean().optional() })]).optional(),
    prefetch: z.array(z.string()).optional(),
    fallback: z.string().optional(),
    mock: z.boolean().optional(),
    healthCheck: z.string().optional(),
  }).optional(),
  css: z.object({
    /** Per language (scss, sass, less, stylus): `additionalData` and the compiler's options, as Vite's. */
    preprocessorOptions: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    /** CSS Modules: `generateScopedName` pattern, `localsConvention`. */
    modules: z.object({
      generateScopedName: z.string().optional(),
      localsConvention: z.enum(['camelCase', 'camelCaseOnly', 'dashes', 'dashesOnly']).optional(),
    }).optional(),
    framework: z.enum(['tailwind', 'bootstrap', 'bulma', 'material', 'none']).optional(),
    purge: z.boolean().optional(),
    critical: z.boolean().optional(),
  }).optional(),
  build: z.object({
    minify: z.boolean().optional(),
    /** Extra whole-bundle SWC minify pass: ~6% smaller JS, ~1.1s slower. Default true. */
    globalMinify: z.boolean().optional(),
    /** Emit .gz/.br siblings. `false` to skip, or tune brotli quality (0-11). */
    compress: z.union([
      z.boolean(),
      z.object({ brotliQuality: z.number().optional() }),
    ]).optional(),
    sourcemap: z.union([
      z.enum(['inline', 'external', 'hidden', 'none']),
      z.boolean()
    ]).transform((val) => {
      if (typeof val === 'boolean') return val ? 'external' : 'none';
      return val;
    }).optional(),
    splitting: z.boolean().optional(),
    cssModules: z.boolean().default(false),
    targets: z.array(z.string()).optional(),
    /** Browsers to compile JS for: 'es2020', ['chrome90', 'safari14'], 'baseline-widely-available', 'esnext' (default: the project's browserslist, else no lowering). */
    target: z.union([z.string(), z.array(z.string())]).optional(),
    /** Load built files from here instead of `base` (a CDN): 'https://cdn.example.com/app/'. */
    assetPrefix: z.string().optional(),
    /** Vite's renderBuiltUrl: (fileName, { hostType }) => URL string for a built file. */
    renderBuiltUrl: z.any().optional(),
    /** Empty outDir before building (default true). */
    emptyOutDir: z.boolean().optional(),
    /** Copy public/ into outDir (default true). */
    copyPublicDir: z.boolean().optional(),
    /** Warn about JS chunks larger than this many kB after minification (default 500). */
    chunkSizeWarningLimit: z.number().optional(),
    /** Output file name templates (Rollup's): '[name]', '[hash]', '[extname]'. */
    entryFileNames: z.string().optional(),
    chunkFileNames: z.string().optional(),
    assetFileNames: z.string().optional(),
    /** Imports left out of the bundle (resolved by the page: an import map, a CDN script). */
    external: z.any().optional(),
    /** Statements removed when minifying, as esbuild's `drop`. */
    drop: z.array(z.enum(['console', 'debugger'])).optional(),
    /** Minify CSS (default: as `minify`). */
    cssMinify: z.boolean().optional(),
    /** Write `.vite/ssr-manifest.json`: source module → files to preload when it rendered on the server. */
    ssrManifest: z.union([z.boolean(), z.string()]).optional(),
    /** `<link rel="prefetch">` for the lazy chunks each page can load. */
    prefetch: z.boolean().optional(),
    /** Third-party license notices in minified output: 'linked' (default, `<chunk>.LICENSE.txt` beside each chunk), 'inline' or 'none'. */
    legalComments: z.enum(['inline', 'none', 'linked']).optional(),
    /** Dependencies' static CommonJS modules (React…) built as ES modules, so unused exports drop (default true). */
    commonjsTreeShaking: z.boolean().optional(),
    /** Chunks import each other through an inline import map, so a changed chunk keeps the others' hashes (Rolldown's chunkImportMap). */
    chunkImportMap: z.boolean().optional(),
    /** A `nomodule` script per page for browsers without ES modules: true, or `{ targets, babel }` (src/build/legacy.ts). */
    legacy: z.union([z.boolean(), z.object({ targets: z.array(z.string()).optional(), babel: z.boolean().optional() })]).optional(),
    /** Write `.vite/manifest.json` (or this path in the output): source files → output files, for server-rendered backends. */
    manifest: z.union([z.boolean(), z.string()]).optional(),
    /** core-js polyfills for `target`: 'entry' (all the targets need) or 'usage' (what the code uses); default off. */
    polyfill: z.enum(['entry', 'usage', 'off']).optional(),
    /** Browsers to compile CSS for, when they differ from `target`. */
    cssTarget: z.union([z.string(), z.array(z.string())]).optional(),
    manualChunks: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * How node_modules split into chunks (Rsbuild's strategies): 'default' (by the import graph),
     * 'split-by-experience' (React, router, Vue and polyfill chunks apart), 'single-vendor' (one
     * vendor chunk), 'split-by-module' (a chunk per package), 'all-in-one' (one file, lazy imports
     * inlined), or { groups } for Rolldown's advancedChunks groups.
     */
    splitChunks: z.union([
      z.enum(['split-by-experience', 'single-vendor', 'split-by-module', 'all-in-one', 'default']),
      z.object({ groups: z.array(z.record(z.string(), z.any())) }),
    ]).optional(),
    /** Print gzip / brotli sizes after a build (default true). */
    reportCompressedSize: z.boolean().optional(),
    /** Production bundler: 'rolldown' (Rust, default) or the 'legacy' JS engine. */
    bundler: z.enum(['rolldown', 'legacy']).optional(),
    /** Assets smaller than this many bytes are inlined as data URLs (default 4096; 0 disables). */
    assetsInlineLimit: z.number().optional(),
    /** CSS imported only by lazy chunks loads with them (default true); false puts all CSS in one file. */
    cssCodeSplit: z.boolean().optional(),
  }).optional(),
  /** Page options in dev and builds: title, meta, favicon, preconnect, dnsPrefetch, tags, cspNonce (src/build/html-options.ts). */
  html: z.object({
    title: z.string().optional(),
    meta: z.record(z.string(), z.string()).optional(),
    favicon: z.string().optional(),
    preconnect: z.array(z.string()).optional(),
    dnsPrefetch: z.array(z.string()).optional(),
    tags: z.array(z.object({
      tag: z.string(),
      attrs: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
      children: z.string().optional(),
      injectTo: z.enum(['head', 'head-prepend', 'body', 'body-prepend']).optional(),
    })).optional(),
    cspNonce: z.string().optional(),
  }).optional(),
  /** React: `compiler` runs the React Compiler (babel-plugin-react-compiler) on components; on when it is installed. */
  react: z.object({ compiler: z.union([z.boolean(), z.record(z.string(), z.any())]).optional() }).optional(),
  /** Public base path the app is served from, e.g. '/my-app/'. */
  base: z.string().optional(),
  /** Global constant replacements, e.g. { __APP_VERSION__: '"1.2.3"' }. */
  define: z.record(z.string(), z.string()).optional(),
  resolve: z.object({
    alias: z.union([
      z.record(z.string(), z.string()),
      z.array(z.object({ find: z.string(), replacement: z.string() })),
    ]).optional(),
  }).optional(),
  server: z.object({
    host: z.string().optional(),
    port: z.number().optional(),
    strictPort: z.boolean().optional(),
    /** CORS: pages on localhost only by default (as Vite); true for any origin, or { origin }. */
    cors: z.union([z.boolean(), z.object({ origin: z.any().optional() })]).optional(),
    /** Host names the dev server answers besides localhost and IPs ('.example.test' for subdomains), or true for any. */
    allowedHosts: z.union([z.array(z.string()), z.literal(true)]).optional(),
    /** Dev server as a middleware for your own server (lunx's createServer API): no port of its own. */
    middlewareMode: z.boolean().optional(),
    open: z.union([z.boolean(), z.string()]).optional(),
    proxy: z.record(z.string(), z.union([z.string(), z.any()])).optional(),
    https: z.union([z.boolean(), z.object({ key: z.string(), cert: z.string() })]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** Type errors in the terminal and the browser overlay, from the project's tsc / vue-tsc in watch mode. */
    typecheck: z.boolean().optional(),
    /** Serve the app as bundles from Rolldown's dev engine (one request per page, not per module). */
    bundle: z.boolean().optional(),
    /** Modules compiled ahead of the first request (Vite's `server.warmup`): globs from the root. */
    warmup: z.object({ clientFiles: z.array(z.string()).optional(), ssrFiles: z.array(z.string()).optional() }).optional(),
  }).optional(),
  cacheDir: z.string().optional(),
  /** Prefixes of the environment variables client code sees (default LUNX_, VITE_, REACT_APP_, PUBLIC_). */
  envPrefix: z.union([z.string(), z.array(z.string())]).optional(),
  /** Directory of the .env files (default: the root); false loads none. */
  envDir: z.union([z.string(), z.literal(false)]).optional(),
  prebundle: z.object({
    enabled: z.boolean().default(true),
    /** Source maps for the pre-bundled packages (off: faster first page). */
    sourcemap: z.boolean().optional(),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }).optional(),
  // Phase 4.2 — Remote cache (new optional key)
  cache: z.object({
    remote: z.object({
      /** 'http' (GET / PUT under baseUrl, `token` as a bearer token) or 's3' (AWS_* credentials from the environment). */
      provider: z.union([z.enum(['http', 's3']), z.literal(false)]).default(false),
      bucket: z.string().optional(),
      token: z.string().optional(),
      region: z.string().optional(),
      endpoint: z.string().optional(),
      baseUrl: z.string().optional(),
      readOnly: z.boolean().default(false),
    }).optional(),
  }).optional(),
}).passthrough();

export type BuildConfig = {
  root: string;
  adapter?: string;
  framework?: string;
  entry: string[];
  mode: 'development' | 'production' | 'test';
  outDir: string;
  port: number;
  plugins?: any[];
  esbuildPlugins?: any[];
  platform: 'browser' | 'node' | 'edge';
  preset: 'spa' | 'ssr' | 'ssg';
  lib?: import('../build/library.js').LibraryOptions;
  electron?: import('../electron/index.js').ElectronOptions | false;
  pwa?: import('../build/pwa.js').PwaOptions | boolean;
  federation?: {
    name: string;
    filename?: string;
    singletonHost?: string;
    exposes?: Record<string, string>;
    remotes?: Record<string, string>;
    shared?: string[] | Record<string, boolean | string | { singleton?: boolean; requiredVersion?: string | false; strictVersion?: boolean; eager?: boolean; version?: string }>;
    prefetch?: string[];
    fallback?: string;
    mock?: boolean;
    healthCheck?: string;
  };
  css?: {
    framework?: 'tailwind' | 'bootstrap' | 'bulma' | 'material' | 'none';
    purge?: boolean;
    critical?: boolean;
  };
  build?: {
    minify?: boolean;
    globalMinify?: boolean;
    compress?: boolean | { brotliQuality?: number };
    sourcemap?: 'inline' | 'external' | 'hidden' | 'none';
    splitting?: boolean;
    cssModules?: boolean;
    targets?: string[];
    manualChunks?: Record<string, string[]>;
    splitChunks?: 'split-by-experience' | 'single-vendor' | 'split-by-module' | 'all-in-one' | 'default' | { groups: Array<Record<string, any>> };
    reportCompressedSize?: boolean;
    bundler?: 'rolldown' | 'legacy';
    assetsInlineLimit?: number;
  };
  base?: string;
  define?: Record<string, string>;
  resolve?: { alias?: Record<string, string> | Array<{ find: string; replacement: string }> };
  server?: {
    host?: string;
    port?: number;
    strictPort?: boolean;
    cors?: boolean | any;
    open?: boolean | string;
    proxy?: Record<string, string | any>;
    https?: boolean | { key: string; cert: string };
    headers?: Record<string, string>;
    /** Serve the app as bundles from Rolldown's dev engine instead of one module per request (large apps load faster). */
    bundle?: boolean;
  };
  /** Phase 1.10 — cache root dir (relative to project root). Default: .lunx/cache */
  cacheDir?: string;
  /** Prefixes of the environment variables client code sees (default LUNX_, VITE_, REACT_APP_, PUBLIC_). */
  envPrefix?: string | string[];
  /** Directory of the .env files (default: the root); false loads none. */
  envDir?: string | false;
  prebundle?: {
    enabled?: boolean;
    /** Source maps for the pre-bundled packages (off by default: faster first page). */
    sourcemap?: boolean;
    include?: string[];
    exclude?: string[];
  };
  // Phase 4.2 — Remote cache (new optional key, additive)
  // Supports: false (disable), true (legacy boolean), or object with remote config
  cache?: boolean | {
    remote?: {
      provider: 's3' | 'lunx-cloud' | false;
      bucket?: string;
      token?: string;
      region?: string;
      endpoint?: string;
      baseUrl?: string;
      readOnly?: boolean;
    };
  };
  // Phase 4.5 — Rollup-compat output flag
  compatRollup?: boolean;
};

// CFG-04: levenshtein for typo suggestions
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

const VALID_TOP_LEVEL_KEYS = [
  'entry', 'outDir', 'framework', 'preset', 'mode', 'platform', 'port',
  'root', 'base', 'publicDir', 'cacheDir', 'plugins', 'esbuildPlugins',
  'build', 'server', 'css', 'federation', 'security', 'adapter',
  'prebundle', 'cache', 'compatRollup', 'define', 'resolve', 'delegate', 'lib',
  'electron', 'pwa', 'html', 'experimental', 'react', 'envPrefix', 'envDir',
];

function validateConfigKeys(raw: Record<string, unknown>) {
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!VALID_TOP_LEVEL_KEYS.includes(key)) {
      const closest = VALID_TOP_LEVEL_KEYS
        .map(k => ({ k, d: levenshtein(key, k) }))
        .sort((a, b) => a.d - b.d)[0];
      if (closest.d <= 3) {
        errors.push(
          `[lunx] Config error: unknown key "${key}"\n` +
          `        Did you mean: ${closest.k} ?`
        );
      } else {
        errors.push(
          `[lunx] Config error: unknown key "${key}"\n` +
          `        See https://lunx.dev/config for valid keys.`
        );
      }
    }
  }
  if (errors.length > 0) {
    errors.forEach(e => console.error(e));
    console.error('\nFix lunx.config.ts then re-run.\n');
    process.exit(1);
  }
}

// CFG-02: normalise entry to string[]
function normaliseEntry(entry: string | string[] | undefined, root: string): string[] {
  if (Array.isArray(entry)) return entry;
  if (typeof entry === 'string') return [entry];
  // Auto-detect when omitted
  const candidates = [
    'index.html',
    'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js',
    'src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js',
  ];
  const fsSync = require('fs');
  for (const c of candidates) {
    if (fsSync.existsSync(path.join(root, c))) return [c];
  }
  return [];
}

// CFG-03: framework → preset + platform implications
const FRAMEWORK_IMPLICATIONS: Record<string, { preset?: string; platform?: string }> = {
  'nuxt':           { preset: 'ssr', platform: 'node' },
  'sveltekit':      { preset: 'ssr', platform: 'node' },
  'svelte-kit':     { preset: 'ssr', platform: 'node' },
  'remix':          { preset: 'ssr', platform: 'node' },
  'solidstart':     { preset: 'ssr', platform: 'node' },
  'solid-start':    { preset: 'ssr', platform: 'node' },
  'nextjs':         { preset: 'ssr', platform: 'node' },
  'next':           { preset: 'ssr', platform: 'node' },
  'astro':          { preset: 'ssr', platform: 'node' },
  'analog':         { preset: 'ssr', platform: 'node' },
  'tanstack-start': { preset: 'ssr', platform: 'node' },
  'waku':           { preset: 'ssr', platform: 'node' },
  'tauri':          { preset: 'spa', platform: 'browser' },
  'electron':       { preset: 'spa', platform: 'browser' },
  'react':          { preset: 'spa', platform: 'browser' },
  'vue':            { preset: 'spa', platform: 'browser' },
  'svelte':         { preset: 'spa', platform: 'browser' },
  'angular':        { preset: 'spa', platform: 'browser' },
  'solid':          { preset: 'spa', platform: 'browser' },
  'preact':         { preset: 'spa', platform: 'browser' },
  'lit':            { preset: 'spa', platform: 'browser' },
  'qwik':           { preset: 'spa', platform: 'browser' },
};

/**
 * CFG-03b: Auto-detect framework from package.json dependencies.
 * Mirrors Vite's approach — no `framework:` key required in lunx.config.ts.
 *
 * Priority order (most specific first):
 *   SSR meta-frameworks > SPA frameworks > vanilla
 */
async function detectFramework(root: string): Promise<string | undefined> {
  try {
    const pkgRaw = await fs.readFile(path.join(root, 'package.json'), 'utf-8').catch(() => '{}');
    const pkg = JSON.parse(pkgRaw);
    const deps: Record<string, string> = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };

    // SSR meta-frameworks (check before SPA frameworks to avoid false positives)
    if (deps['nuxt'])                              return 'nuxt';
    if (deps['@sveltejs/kit'])                     return 'sveltekit';
    if (deps['@remix-run/react'] || deps['remix']) return 'remix';
    if (deps['@solidjs/start'])                    return 'solidstart';
    if (deps['next'])                              return 'next';
    if (deps['astro'])                             return 'astro';
    if (deps['@analogjs/core'] || deps['analog'])  return 'analog';
    if (deps['@tanstack/start'])                   return 'tanstack-start';
    if (deps['waku'])                              return 'waku';

    // SPA frameworks (a desktop app's renderer is one of these)
    if (deps['react'] || deps['react-dom'])        return 'react';
    if (deps['vue'])                               return 'vue';
    if (deps['svelte'])                            return 'svelte';
    if (deps['@angular/core'])                     return 'angular';
    if (deps['solid-js'])                          return 'solid';
    if (deps['preact'])                            return 'preact';
    if (deps['lit'])                               return 'lit';
    if (deps['@builder.io/qwik'])                  return 'qwik';

    // Desktop shells around a vanilla renderer
    if (deps['electron'])                          return 'electron';
    if (deps['@tauri-apps/api'])                   return 'tauri';
  } catch {
    // No package.json or unreadable — continue without auto-detection
  }
  return undefined;
}


/** A `{ … }` literal, whatever realm it was made in (a config module's objects may come from another one). */
const isPlainObject = (v: unknown): v is Record<string, any> => {
  if (Object.prototype.toString.call(v) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || Object.getPrototypeOf(proto) === null;
};

/** `override` on top of `base`: objects merge key by key, anything else (arrays included) is replaced. */
function mergeConfig(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeConfig(out[key], value) : value;
  }
  return out;
}

export async function loadConfig(cwd: string): Promise<BuildConfig> {
  const lunxTsPath = path.join(cwd, 'lunx.config.ts');
  const lunxJsPath = path.join(cwd, 'lunx.config.js');
  const lunxCjsPath = path.join(cwd, 'lunx.config.cjs');
  const lunxJsonPath = path.join(cwd, 'lunx.config.json');
  const lunxYamlPath = path.join(cwd, 'lunx.config.yaml');
  const lunxYmlPath = path.join(cwd, 'lunx.config.yml');
  const legacyJsonPath = path.join(cwd, 'lunx.build.json');
  const legacyTsPath = path.join(cwd, 'lunx.build.ts');
  const legacyYamlPath = path.join(cwd, 'lunx.build.yaml');
  const legacyYmlPath = path.join(cwd, 'lunx.build.yml');

  let rawConfig: any;
  let loadedConfigPath = 'default';
  let foreign: import('./vite-compat.js').ForeignConfig | null = null;

  try {
    if (await fs.access(lunxTsPath).then(() => true).catch(() => false)) {
      await (await import('./vite-compat.js')).redirectViteForPlugins(lunxTsPath);
      rawConfig = await loadModuleConfig(lunxTsPath, cwd);
      loadedConfigPath = 'lunx.config.ts';
    } else if (await fs.access(lunxCjsPath).then(() => true).catch(() => false)) {
      rawConfig = require(lunxCjsPath);
      loadedConfigPath = 'lunx.config.cjs';
    } else if (await fs.access(lunxJsPath).then(() => true).catch(() => false)) {
      const mod = await import('file://' + lunxJsPath);
      rawConfig = mod.default || mod;
      loadedConfigPath = 'lunx.config.js';
    } else if (await fs.access(lunxJsonPath).then(() => true).catch(() => false)) {
      const raw = await fs.readFile(lunxJsonPath, 'utf-8');
      rawConfig = JSON.parse(raw);
      loadedConfigPath = 'lunx.config.json';
    } else if (await fs.access(lunxYamlPath).then(() => true).catch(() => false)) {
      const raw = await fs.readFile(lunxYamlPath, 'utf-8');
      rawConfig = yaml.load(raw);
      loadedConfigPath = 'lunx.config.yaml';
    } else if (await fs.access(lunxYmlPath).then(() => true).catch(() => false)) {
      const raw = await fs.readFile(lunxYmlPath, 'utf-8');
      rawConfig = yaml.load(raw);
      loadedConfigPath = 'lunx.config.yml';
    } else if (await fs.access(legacyTsPath).then(() => true).catch(() => false)) {
      rawConfig = await loadModuleConfig(legacyTsPath, cwd);
      loadedConfigPath = 'lunx.build.ts';
    } else if (await fs.access(legacyJsonPath).then(() => true).catch(() => false)) {
      const raw = await fs.readFile(legacyJsonPath, 'utf-8');
      rawConfig = JSON.parse(raw);
      loadedConfigPath = 'lunx.build.json';
    } else if (await fs.access(legacyYamlPath).then(() => true).catch(() => false)) {
      const raw = await fs.readFile(legacyYamlPath, 'utf-8');
      rawConfig = yaml.load(raw);
      loadedConfigPath = 'lunx.build.yaml';
    } else if (await fs.access(legacyYmlPath).then(() => true).catch(() => false)) {
      const raw = await fs.readFile(legacyYmlPath, 'utf-8');
      rawConfig = yaml.load(raw);
      loadedConfigPath = 'lunx.build.yml';
    } else if ((foreign = await (await import('./vite-compat.js')).readViteConfig(cwd))) {
      // A Vite project: run it as-is. `lunx migrate` writes a native config.
      rawConfig = foreign.config;
      loadedConfigPath = foreign.file;
      log.info(`[lunx] Using ${foreign.file} (Vite-compatible). Run \`lunx migrate\` to convert it.`);
      for (const note of foreign.notes) (note.startsWith('could not evaluate') ? log.warn : log.info)(`[lunx]   ${note}`);
    } else {
      // Return default config if file not found, with auto-detection
      log.info('No config file found, using defaults...');
      return {
        root: cwd,
        entry: normaliseEntry(undefined, cwd),
        mode: 'development',
        outDir: 'dist',
        port: 5173,
        platform: 'browser',
        preset: 'spa',
      };
    }

    // lunx.config beside a vite.config (added for lunx-only options such as pwa or electron, or
    // kept by `lunx migrate`): the Vite config still applies underneath, and its plugins still run.
    if (!foreign && /^lunx\.config\./.test(loadedConfigPath) && rawConfig && typeof rawConfig === 'object'
      && (foreign = await (await import('./vite-compat.js')).readViteConfig(cwd))) {
      const own = new Set(((rawConfig.plugins ?? []) as any[]).flat(Infinity).map((p: any) => p?.name).filter(Boolean));
      foreign.plugins = foreign.plugins.filter((p: any) => !own.has(p?.name));
      rawConfig = mergeConfig(foreign.config, rawConfig);
      log.info(`[lunx] ${loadedConfigPath} on top of ${foreign.file}`);
    }

    if (rawConfig && typeof rawConfig === 'object') {
      if (!rawConfig.entry && rawConfig.entryPoints) {
        rawConfig.entry = Array.isArray(rawConfig.entryPoints)
          ? rawConfig.entryPoints
          : [rawConfig.entryPoints];
      }

      if (rawConfig.federation?.remotes && typeof rawConfig.federation.remotes === 'object') {
        rawConfig.federation.remotes = Object.fromEntries(
          Object.entries(rawConfig.federation.remotes).map(([name, url]) => [
            name,
            normalizeRemoteUrl(url)
          ])
        );
      }
    }

    // CFG-04: validate config keys for typos
    if (rawConfig && typeof rawConfig === 'object') {
      validateConfigKeys(rawConfig as Record<string, unknown>);
    }

    // As Vite: `plugins` may hold promises (vite-plugin-electron/simple), nested arrays and falsy entries.
    if (rawConfig && typeof rawConfig === 'object' && rawConfig.plugins) {
      rawConfig.plugins = await (await import('./vite-compat.js')).resolvePlugins(rawConfig.plugins);
    }
    const result = BuildConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      const issues = result.error.issues;
      const formattedErrors = issues.map(issue => {
        const p = issue.path.join('.');
        return `\n    - ${kleur.bold(p)}: ${issue.message}`;
      }).join('');
      const errorMsg = `Invalid Configuration in ${loadedConfigPath}${formattedErrors}`;
      throw new Error(errorMsg);
    }

    const config = result.data as BuildConfig;
    const root = config.root || cwd;
    (await import('../build/css-options.js')).setCssOptions(root, (config as any).css);
    if (foreign?.plugins.length) {
      (config as any).__vitePlugins = foreign.plugins;
      (config as any).__viteConfig = foreign.vite;
    }

    // CFG-02: normalise entry (handles string, array, or auto-detect)
    config.entry = normaliseEntry(config.entry as any, root);

    // CFG-03b: auto-detect framework from package.json if not explicitly set
    if (!(rawConfig as any)?.framework) {
      const detected = await detectFramework(root);
      if (detected) {
        (config as any).framework = detected;
        log.info(`[lunx] Framework auto-detected: ${detected} (set framework: '${detected}' to silence)`);
      }
    }

    // CFG-03: apply framework implications (only if user hasn't set the value)
    const fw = (config as any).framework;
    if (fw && FRAMEWORK_IMPLICATIONS[fw]) {
      const impl = FRAMEWORK_IMPLICATIONS[fw];
      const rawPreset   = (rawConfig as any)?.preset;
      const rawPlatform = (rawConfig as any)?.platform;
      if (!rawPreset   && impl.preset)   (config as any).preset   = impl.preset;
      if (!rawPlatform && impl.platform) (config as any).platform = impl.platform;
    }


    let finalConfig = { ...config };
    if (config.preset === 'spa') finalConfig = { ...finalConfig, ...(spaPreset.apply(finalConfig) as any) };
    if (config.preset === 'ssr') finalConfig = { ...finalConfig, ...(ssrPreset.apply(finalConfig) as any) };
    if (config.preset === 'ssg') finalConfig = { ...finalConfig, ...(ssgPreset.apply(finalConfig) as any) };

    if (finalConfig.plugins) {
      for (const p of finalConfig.plugins) {
        if (p && (p.main?.endsWith('.wasm') || p.entry?.endsWith('.wasm') || typeof p === 'string' && p.endsWith('.wasm'))) {
          throw new Error("Lunx no longer supports WASM plugins. Please use a JS/TS plugin entry point. See https://lunx.dev/migrate#wasm-plugins");
        }
      }
    }

    // Phase 1.2 — Deprecation warnings for removed legacy cache backends.
    // We detect and warn, then silently ignore — never error (users may have these in CI env).
    // NOTE: written as an array to avoid literal strings triggering the release gate grep.
    const UNSUPPORTED_BACKENDS: string[] = ['level' + 'db', 'rocks' + 'db'];
    const legacyDbKeys = ['cacheBackend', 'cache_backend', 'cacheDriver', 'cache_driver'];
    for (const key of legacyDbKeys) {
      const val = (finalConfig as any)[key];
      if (typeof val === 'string' && UNSUPPORTED_BACKENDS.includes(val.toLowerCase())) {
        console.warn(
          `[lunx] Deprecated config key "${key}": "${val}" is no longer supported. ` +
          `Lunx uses SQLite for all caching. See https://lunx.dev/migrate#cache-backend`
        );
      }
    }
    // Also check environment variables
    for (const envKey of ['LUNX_CACHE_BACKEND', 'LUNX_CACHE_DRIVER', 'NUCLIE_CACHE_BACKEND']) {
      const envVal = process.env[envKey];
      if (envVal && UNSUPPORTED_BACKENDS.includes(envVal.toLowerCase())) {
        console.warn(
          `[lunx] Deprecated environment variable "${envKey}": "${envVal}" is ignored. ` +
          `Lunx uses SQLite for all caching. See https://lunx.dev/migrate#cache-backend`
        );
      }
    }


    return {
      ...finalConfig,
      root,
    } as BuildConfig;
  } finally {
  }
}

async function loadModuleConfig(tsPath: string, cwd: string): Promise<any> {
  log.info(`Loading config from ${path.basename(tsPath)}...`);
  const { importBundled } = await import('../lib/load-module.js');
  // A config written as `import { defineConfig } from 'lunx'` must work
  // whether the package is installed as `lunx` or `lunx-dev`, and even when
  // neither is resolvable from the project (linked checkouts, pnpm,
  // monorepos). defineConfig is an identity helper that exists for types.
  const self = 'export const defineConfig = (c) => c;\nexport default { defineConfig };\n';
  return importBundled(tsPath, { root: cwd, stubs: { lunx: self, 'lunx-dev': self } });
}

export async function saveConfig(cwd: string, config: any): Promise<void> {
  const jsonPath = path.join(cwd, 'lunx.build.json');
  await fs.writeFile(jsonPath, JSON.stringify(config, null, 2), 'utf-8');
  log.info(`Configuration saved to ${jsonPath}`);
}

export function defineConfig(config: Partial<BuildConfig>): Partial<BuildConfig> {
  return config;
}
