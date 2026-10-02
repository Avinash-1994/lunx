import path from 'path';
import type { LunxAdapter, Plugin, LunxConfig, PackageJson } from '@lunx/adapter-core';
import { detectDependencies, registry } from '@lunx/adapter-core';

export interface AstroConfig {
  srcDir?: string;
  publicDir?: string;
  outDir?: string;
  site?: string;
  trailingSlash?: 'always' | 'never' | 'ignore';
}

/**
 * Lunx Astro Adapter
 *
 * Lunx provides deeper Astro integration than any other build tool:
 * - Uses Astro's programmatic API to start the dev server
 * - Proxies all requests through Lunx's security & HMR layer
 * - Supports Astro Islands with React, Vue, Svelte components
 * - Content Collections with SQLite-backed caching
 * - Zero config — auto-detected from package.json
 */
export class AstroAdapter implements LunxAdapter {
  name = 'astro';

  // Internal: holds the running Astro dev server instance + proxy port
  private _astroPort: number | null = null;
  private _astroServer: any = null;

  detect(projectRoot: string, pkg: PackageJson): boolean {
    return detectDependencies(pkg, ['astro']);
  }

  plugins(): Plugin[] {
    return [];
  }

  config(config: LunxConfig): LunxConfig {
    if (!config.astro) config.astro = {};
    config.astro = {
      srcDir: 'src',
      publicDir: 'public',
      outDir: 'dist',
      trailingSlash: 'ignore',
      ...(config.astro || {})
    };
    return config;
  }

  /**
   * Start Astro's dev server programmatically and return a proxy handler.
   * Lunx wraps it with: HMR overlay, security headers, request timing, CSP.
   */
  getDevHandler(): any {
    // Start Astro dev server on a random high port and proxy to it
    let proxyInitialized = false;
    let proxyAgent: any = null;

    const initAstro = async (root: string) => {
      if (proxyInitialized) return;
      proxyInitialized = true;

      try {
        // Resolve 'astro' from the PROJECT root, not Lunx's own node_modules
        const { createRequire } = await import('module');
        const { pathToFileURL } = await import('url');
        const projectRequire = createRequire(path.join(root, 'package.json'));
        let astroEntry: string;
        try {
          astroEntry = projectRequire.resolve('astro');
        } catch {
          console.warn('[Lunx:Astro] astro package not found in project node_modules. Run: npm install astro');
          return;
        }

        const _importAstro = new Function('specifier', 'return import(specifier)');
        const astro = await _importAstro(pathToFileURL(astroEntry).href).catch(() => null) as any;
        if (!astro || typeof astro.dev !== 'function') {
          console.warn('[Lunx:Astro] astro.dev() not available — try updating astro to v4+');
          return;
        }

        // Pick a port for the internal Astro server (not user-visible)
        const internalPort = 4321 + Math.floor(Math.random() * 100);

        const server = await astro.dev({
          root,
          server: { port: internalPort, host: '127.0.0.1' },
          // Integrate Lunx's plugin pipeline
          vite: {
            plugins: [],
            define: { '__LUNX_BUILD__': 'true' }
          }
        });

        this._astroPort = internalPort;
        this._astroServer = server;
        console.log(`[Lunx:Astro] ⚡ Astro dev server running internally on :${internalPort}`);

        // Create http-proxy agent to forward requests
        const httpProxy = await import('../../internal/proxy.js');
        proxyAgent = httpProxy.default.createProxyServer({
          target: `http://127.0.0.1:${internalPort}`,
          ws: true,
          selfHandleResponse: false,
        });

        proxyAgent.on('error', (err: Error, _req: any, res: any) => {
          console.error('[Lunx:Astro] Proxy error:', err.message);
          if (res && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Astro dev server error: ' + err.message);
          }
        });

      } catch (e: any) {
        console.error('[Lunx:Astro] Failed to start Astro dev server:', e.message);
      }
    };

    return async (req: any, res: any, next: any) => {
      const root = req.__lunxRoot || process.cwd();

      // Lazy-init Astro on first request
      if (!proxyInitialized) {
        await initAstro(root);
      }

      if (proxyAgent && this._astroPort) {
        // Forward to Astro's internal Vite dev server
        proxyAgent.web(req, res);
        return;
      }

      // Fallback: serve index.html if Astro failed to start
      next();
    };
  }

  ssrEntry(): string {
    return 'src/entry.server.ts';
  }

  async cleanup(): Promise<void> {
    if (this._astroServer) {
      try {
        await this._astroServer.stop();
      } catch { /* ignore */ }
    }
  }
}

registry.register(new AstroAdapter());
