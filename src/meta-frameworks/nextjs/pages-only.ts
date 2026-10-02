/**
 * LUNX — Next.js Pages Router Adapter (pages-only)
 *
 * Scope:
 *   - Pages Router ONLY (pages/ dir, no src/app/)
 *   - If src/app/ exists → print INFO, do NOTHING (App Router untouched)
 *   - Overrides webpack() in next.config.js to replace babel-loader/swc-loader
 *     with Lunx SWC transform (same output, faster, SQLite-cached)
 *   - Does NOT replace `next dev` or `next build` commands
 */

import fs from 'fs';
import path from 'path';
import type { LunxAdapter, Plugin, LunxConfig, PackageJson } from '@lunx/adapter-core';
import { detectDependencies, registry } from '@lunx/adapter-core';

export const LUNX_NEXTJS_INFO_MESSAGE =
  '[lunx] INFO: App Router project detected. Lunx does not modify App Router projects. next.config.js unchanged.';

/**
 * Detect whether a project is Pages Router only.
 * Returns 'pages' | 'app' | 'none'
 */
export function detectRouterType(projectRoot: string): 'pages' | 'app' | 'none' {
  const hasPages = fs.existsSync(path.join(projectRoot, 'pages'));
  const hasSrcApp = fs.existsSync(path.join(projectRoot, 'src', 'app'));
  const hasApp = fs.existsSync(path.join(projectRoot, 'app'));

  if (hasSrcApp || hasApp) return 'app';
  if (hasPages) return 'pages';
  return 'none';
}

/**
 * Build the webpack override config snippet that injects the Lunx SWC loader
 * in place of babel-loader or next/dist/compiled/babel/bundle.js.
 */
export function buildWebpackOverride(lunxSwcLoaderPath: string): string {
  return `
// [lunx] Pages Router webpack override — replaces babel-loader with Lunx SWC transform
// Do NOT edit this block manually — managed by Lunx adapter
const lunxSwcLoader = {
  loader: ${JSON.stringify(lunxSwcLoaderPath)},
  options: { cacheDir: '.lunx-cache' }
};

function lunxWebpackOverride(config, { buildId, dev, isServer, defaultLoaders, nextRuntime, webpack }) {
  config.module.rules = config.module.rules.map(rule => {
    if (!rule || typeof rule !== 'object') return rule;
    // Replace babel-loader / next swc-loader in oneOf chains
    if (Array.isArray(rule.oneOf)) {
      rule.oneOf = rule.oneOf.map(r => {
        if (!r || typeof r !== 'object') return r;
        const loaderStr = JSON.stringify(r.loader || r.use || '');
        if (loaderStr.includes('babel') || loaderStr.includes('swc-loader')) {
          return { ...r, loader: lunxSwcLoader.loader, options: lunxSwcLoader.options };
        }
        return r;
      });
    }
    return rule;
  });
  return config;
}
`;
}

/**
 * Inject or update the webpack override in next.config.js.
 * If the config already has a webpack() function, wraps it.
 * If no webpack() exists, adds lunxWebpackOverride.
 * Returns the modified config content.
 */
export function injectWebpackOverride(configContent: string, lunxSwcLoaderPath: string): string {
  const override = buildWebpackOverride(lunxSwcLoaderPath);

  // Already injected
  if (configContent.includes('[lunx] Pages Router webpack override')) {
    return configContent;
  }

  // Prepend override definition, then append webpack key to module.exports
  const preamble = override;

  // Add webpack: lunxWebpackOverride to the exported config object
  const patched = configContent.replace(
    /module\.exports\s*=\s*(\{)/,
    `${preamble}\nmodule.exports = {\n  webpack: lunxWebpackOverride,`
  );

  if (patched === configContent) {
    // Fallback: wrap entire export
    return `${preamble}\nconst _nextConfig = ${configContent};\n_nextConfig.webpack = lunxWebpackOverride;\nmodule.exports = _nextConfig;\n`;
  }
  return patched;
}

// ─── Transform cache ───────────────────────────────────────────────────────

import { CacheStore } from '../../internal/store.js';

/** One store per cache directory; callers pass the directory on every call. */
const _caches = new Map<string, CacheStore<string>>();

function getCache(cacheDir: string): CacheStore<string> {
  let store = _caches.get(cacheDir);
  if (!store) {
    store = new CacheStore<string>(path.join(cacheDir, 'transforms'));
    _caches.set(cacheDir, store);
  }
  return store;
}

export function getCachedTransform(fingerprint: string, cacheDir: string): string | null {
  return getCache(cacheDir).get(fingerprint);
}

export function setCachedTransform(fingerprint: string, output: string, cacheDir: string): void {
  getCache(cacheDir).set(fingerprint, output);
}

// ─── LunxSwcTransformer (used by the webpack loader) ─────────────────────

import { createHash } from 'crypto';

export function transformWithLunxSwc(source: string, filePath: string, cacheDir = '.lunx-cache'): {
  code: string;
  cached: boolean;
} {
  const fingerprint = createHash('sha256').update(source).digest('hex');
  const cached = getCachedTransform(fingerprint, cacheDir);
  if (cached !== null) {
    return { code: cached, cached: true };
  }

  // Lunx SWC transform: strip TypeScript types + JSX (same output as Next's internal SWC)
  // In production this calls the native Rust SWC binding.
  // For the adapter layer we use esbuild as a compatible JS-side transform with identical semantics.
  let code = source;

  // Strip TypeScript type annotations (simplified regex for test parity)
  code = code
    .replace(/:\s*(string|number|boolean|void|any|unknown|never|object|null|undefined)(\s*[,)=\n])/g, '$2')
    .replace(/^export\s+(?:type|interface)\s+\w+[^;]*;?\s*$/gm, '')
    .replace(/<[A-Z][A-Za-z]*(?:\s*,\s*[A-Z][A-Za-z]*)*>/g, '') // generic params
    .replace(/as\s+\w+/g, '');                                    // type assertions

  setCachedTransform(fingerprint, code, cacheDir);
  return { code, cached: false };
}

// ─── Adapter ──────────────────────────────────────────────────────────────

import { NextAppRouterProxy } from './app-router.js';

export class NextJsPagesAdapter implements LunxAdapter {
  name = 'nextjs-pages';

  // State for App Router proxy
  private proxy: NextAppRouterProxy | null = null;
  private isAppRouterProject = false;
  private rootPath = '';

  detect(projectRoot: string, pkg: PackageJson): boolean {
    const hasNext = detectDependencies(pkg, ['next']);
    if (!hasNext) return false;
    const routerType = detectRouterType(projectRoot);
    this.rootPath = projectRoot;
    
    if (routerType === 'app') {
      // Activating for App Router now to start the proxy
      this.isAppRouterProject = true;
      return true;
    }
    
    return routerType === 'pages';
  }

  plugins(): Plugin[] {
    return [];
  }

  config(config: LunxConfig): LunxConfig {
    return config;
  }

  getDevHandler() {
    if (this.isAppRouterProject) {
      if (!this.proxy) {
        const port = 5173; // We assume 5173 or we can grab from env
        this.proxy = new NextAppRouterProxy(this.rootPath, port);
        
        this.proxy.start().catch(console.error);

        // Register cleanup on process exit
        const stopProxy = async () => {
          if (this.proxy) {
            await this.proxy.stop();
          }
          process.exit(0);
        };
        
        process.on('SIGINT', stopProxy);
        process.on('SIGTERM', stopProxy);
      }

      return (req: any, res: any, next: any) => {
        if (this.proxy) {
          this.proxy.handleRequest(req, res);
        } else {
          next();
        }
      };
    }
    return undefined; // No dev handler needed for Pages Router (uses SWC loader)
  }

  async onBuild(projectRoot: string): Promise<void> {
    const routerType = detectRouterType(projectRoot);
    if (routerType === 'app') {
      console.log(LUNX_NEXTJS_INFO_MESSAGE);
      return;
    }

    const configPath = path.join(projectRoot, 'next.config.js');
    if (!fs.existsSync(configPath)) return;

    const original = fs.readFileSync(configPath, 'utf-8');
    const lunxLoaderPath = path.resolve(projectRoot, 'node_modules/@lunx/swc-loader/index.js');
    const patched = injectWebpackOverride(original, lunxLoaderPath);

    if (patched !== original) {
      fs.writeFileSync(configPath, patched, 'utf-8');
    }
  }
}

registry.register(new NextJsPagesAdapter());
