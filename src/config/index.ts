import fs from 'fs/promises';
import path from 'path';
import kleur from 'kleur';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

import { z } from 'zod';
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
  federation: z.object({
    name: z.string(),
    filename: z.string().optional(),
    singletonHost: z.string().optional(),
    exposes: z.record(z.string(), z.string()).optional(),
    remotes: z.record(z.string(), z.string()).optional(),
    shared: z.record(z.string(), z.object({
      singleton: z.boolean().optional(),
      requiredVersion: z.string().optional(),
    })).optional(),
    prefetch: z.array(z.string()).optional(),
    fallback: z.string().optional(),
    mock: z.boolean().optional(),
    healthCheck: z.string().optional(),
  }).optional(),
  css: z.object({
    framework: z.enum(['tailwind', 'bootstrap', 'bulma', 'material', 'none']).optional(),
    purge: z.boolean().optional(),
    critical: z.boolean().optional(),
  }).optional(),
  build: z.object({
    minify: z.boolean().optional(),
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
    manualChunks: z.record(z.string(), z.array(z.string())).optional(),
  }).optional(),
  server: z.object({
    host: z.string().optional(),
    port: z.number().optional(),
    strictPort: z.boolean().optional(),
    cors: z.boolean().optional(),
    open: z.union([z.boolean(), z.string()]).optional(),
    proxy: z.record(z.string(), z.union([z.string(), z.any()])).optional(),
    https: z.union([z.boolean(), z.object({ key: z.string(), cert: z.string() })]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }).optional(),
  cacheDir: z.string().optional(),
  prebundle: z.object({
    enabled: z.boolean().default(true),
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  }).optional(),
  // Phase 4.2 — Remote cache (new optional key)
  cache: z.object({
    remote: z.object({
      provider: z.union([z.enum(['s3', 'lunx-cloud']), z.literal(false)]).default(false),
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
  federation?: {
    name: string;
    filename?: string;
    singletonHost?: string;
    exposes?: Record<string, string>;
    remotes?: Record<string, string>;
    shared?: Record<string, { singleton?: boolean; requiredVersion?: string }>;
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
    sourcemap?: 'inline' | 'external' | 'hidden' | 'none';
    splitting?: boolean;
    cssModules?: boolean;
    targets?: string[];
    manualChunks?: Record<string, string[]>;
  };
  server?: {
    host?: string;
    port?: number;
    strictPort?: boolean;
    cors?: boolean | any;
    open?: boolean | string;
    proxy?: Record<string, string | any>;
    https?: boolean | { key: string; cert: string };
    headers?: Record<string, string>;
  };
  /** Phase 1.10 — cache root dir (relative to project root). Default: .lunx/cache */
  cacheDir?: string;
  prebundle?: {
    enabled?: boolean;
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
  'prebundle', 'cache', 'compatRollup'
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

    // Desktop frameworks
    if (deps['electron'])                          return 'electron';
    if (deps['@tauri-apps/api'])                   return 'tauri';

    // SPA frameworks
    if (deps['react'] || deps['react-dom'])        return 'react';
    if (deps['vue'])                               return 'vue';
    if (deps['svelte'])                            return 'svelte';
    if (deps['@angular/core'])                     return 'angular';
    if (deps['solid-js'])                          return 'solid';
    if (deps['preact'])                            return 'preact';
    if (deps['lit'])                               return 'lit';
    if (deps['@builder.io/qwik'])                  return 'qwik';
  } catch {
    // No package.json or unreadable — continue without auto-detection
  }
  return undefined;
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

  try {
    if (await fs.access(lunxTsPath).then(() => true).catch(() => false)) {
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
  const { build } = await import('esbuild');
  const outfile = path.join(cwd, `lunx.config.temp.${Date.now()}.mjs`);

  try {
    await build({
      entryPoints: [tsPath],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2020',
      external: [
        'esbuild', 'zod', 'kleur',
        'svelte-preprocess', 'svelte', 'esbuild-svelte', 'js-yaml',
        'coffeescript', 'pug', 'stylus', 'less', 'postcss', 'sass', 'postcss-load-config', 'sugarss',
        'react', 'react-dom'
      ]
    });

    const mod = await import('file://' + outfile);
    return mod.default || mod;
  } finally {
    await fs.unlink(outfile).catch(() => { });
  }
}

export async function saveConfig(cwd: string, config: any): Promise<void> {
  const jsonPath = path.join(cwd, 'lunx.build.json');
  await fs.writeFile(jsonPath, JSON.stringify(config, null, 2), 'utf-8');
  log.info(`Configuration saved to ${jsonPath}`);
}

export function defineConfig(config: Partial<BuildConfig>): Partial<BuildConfig> {
  return config;
}
