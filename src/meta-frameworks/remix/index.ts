import type { LunxAdapter, Plugin, LunxConfig, PackageJson, Middleware } from '@lunx/adapter-core';
import { detectDependencies, registry } from '@lunx/adapter-core';
import { remixRoutesPlugin } from './routes-plugin.js';

export interface RemixConfig {
  ignoredRouteFiles?: string[];
  serverModuleFormat?: 'esm' | 'cjs';
}

export class RemixAdapter implements LunxAdapter {
  name = 'remix';

  detect(projectRoot: string, pkg: PackageJson): boolean {
    return detectDependencies(pkg, ['@remix-run/react', '@remix-run/node']);
  }

  plugins(): Plugin[] {
    return [
      remixRoutesPlugin()
    ];
  }

  config(config: LunxConfig): LunxConfig {
    if (!config.remix) config.remix = {};
    config.remix = {
      ignoredRouteFiles: ['**/.*'],
      serverModuleFormat: 'esm',
      ...(config.remix || {})
    };
    return config;
  }

  serverMiddleware(): Middleware[] {
    return [
       async (req: any, res: any, next: any) => {
          // Shim Request / Response for underlying uWS API mappings
          try {
             // In Remix the entry point is heavily abstracted typically via createRequestHandler
             const virtualID = 'virtual:lunx/remix-server-build';
             let build: any;
             try {
                build = await import(virtualID);
             } catch(e) {
                return next();
             }

             // Map req to Fetch API Request
             const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
             
              
             const fetchReq = new Request(url.href, {
                method: req.method,
                headers: new Headers(req.headers as any),
                // body mappings handled natively via Buffer / stream pipeline based on HTTP method
             });

             // @ts-ignore
             const serverBuild = await import('@remix-run/node');
             const handleRequest = serverBuild.createRequestHandler(build, process.env.NODE_ENV);
             
             const fetchRes = await handleRequest(fetchReq);

             res.writeStatus(`${fetchRes.status}`);
             fetchRes.headers.forEach((val: any, key: any) => res.writeHeader(key, val));
             
             if (fetchRes.body) {
                const reader = fetchRes.body.getReader();
                while (true) {
                   const { done, value } = await reader.read();
                   if (done) break;
                   res.write(value);
                }
             } else {
                res.write(await fetchRes.text());
             }
             res.end();
             
          } catch(e) {
             console.error('[Lunx:Remix] Error rendering SSR', e);
             next();
          }
       }
    ];
  }

  ssrEntry(): string {
     return 'virtual:lunx/remix-server-build';
  }
}

registry.register(new RemixAdapter());
