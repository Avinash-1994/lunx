/**
 * SSR Server Runtime
 * Universal server-side rendering for Next.js, Nuxt, and Remix
 */

import { loadUWS, type HttpRequest as UWSHttpRequest, type HttpResponse as UWSHttpResponse, type TemplatedApp as UWSTemplatedApp } from '../../lib/uws.js';
import path from 'path';
import fs from 'fs/promises';
import { Route, RouteMatch } from '../types.js';
import { NextJsRouter } from '../nextjs/router.js';
import { NuxtRouter } from '../nuxt/router.js';
import { RemixRouter } from '../remix/router.js';
import { log } from '../../utils/logger.js';
import { ReactSSRRenderer } from './react-renderer.js';
import { VueSSRRenderer } from './vue-renderer.js';

/**
 * Some transformed output expects a global `React`. It is the user's
 * dependency, so resolve it lazily and stay silent when the project is not a
 * React project.
 */
async function polyfillGlobalReact(): Promise<void> {
    if ((global as any).React) return;
    try {
        const react = await import('react');
        (global as any).React = (react as any).default ?? react;
    } catch {
        // Not a React project; nothing to polyfill.
    }
}

export interface SSRConfig {
    root: string;
    framework: 'nextjs' | 'nuxt' | 'remix';
    outDir: string;
    port: number;
    production?: boolean;
    template?: string;
}

export interface RenderContext {
    route: Route;
    req: any;
    res: any;
    params: Record<string, string>;
    query: Record<string, string>;
    data?: any;
}

// Minimal mock to handle Next/Remix server functions that expect Express req/res
function createMockReq(res: UWSHttpResponse, req: UWSHttpRequest): any {
    let url = req.getUrl();
    if (req.getQuery().length > 0) url += '?' + req.getQuery();
    
    const headers: Record<string, string> = {};
    req.forEach((k, v) => {
        headers[k] = v;
    });

    return {
        path: req.getUrl(),
        url,
        method: req.getMethod().toUpperCase(),
        headers,
        query: {} // Will be populated by router matcher later if needed
    };
}

function createMockRes(res: UWSHttpResponse): any {
    // uWebSockets.js handles backpressure internally, but we need an abstraction
    let writeStatus = 200;
    const writeHeaders: Record<string, string> = {};
    let isTerminated = false;

    res.onAborted(() => {
        isTerminated = true;
    });

    return {
        status: function(code: number) {
            writeStatus = code;
            return this;
        },
        setHeader: function(key: string, value: string) {
            writeHeaders[key.toLowerCase()] = value;
            return this;
        },
        writeHead: function(status: number, headers: any) {
            writeStatus = status;
            if (headers) {
                Object.assign(writeHeaders, headers);
            }
            return this;
        },
        json: function(data: any) {
            this.send(JSON.stringify(data), 'application/json');
        },
        send: function(data: any, contentType: string = 'text/html') {
            if (isTerminated) return;
            res.cork(() => {
                res.writeStatus(writeStatus.toString());
                res.writeHeader('content-type', contentType);
                for (const [k, v] of Object.entries(writeHeaders)) {
                    if (k !== 'content-type') res.writeHeader(k, v);
                }
                res.end(data);
            });
        },
        end: function(data?: any) {
            if (isTerminated) return;
            res.cork(() => {
                res.writeStatus(writeStatus.toString());
                for (const [k, v] of Object.entries(writeHeaders)) {
                    res.writeHeader(k, v);
                }
                if (data) res.end(data);
                else res.end();
            });
        }
    };
}

export class SSRServer {
    private app: UWSTemplatedApp;
    private config: SSRConfig;
    private router: NextJsRouter | NuxtRouter | RemixRouter;

    constructor(config: SSRConfig) {
        this.config = config;
        this.app = loadUWS().App();

        // Initialize framework-specific router
        this.router = this.createRouter();
    }

    private createRouter() {
        const routerConfig = {
            root: this.config.root,
            framework: this.config.framework
        };

        switch (this.config.framework) {
            case 'nextjs':
                return new NextJsRouter(routerConfig);
            case 'nuxt':
                return new NuxtRouter(routerConfig);
            case 'remix':
                return new RemixRouter(routerConfig);
            default:
                throw new Error(`Unsupported framework: ${this.config.framework}`);
        }
    }

    private serveStatic(pathPrefix: string, rootDir: string) {
        this.app.get(pathPrefix + '/*', async (res, req) => {
            let isAborted = false;
            res.onAborted(() => { isAborted = true; });

            const url = req.getUrl();
            const relativePath = url.substring(pathPrefix.length);
            const tryPath = path.join(rootDir, relativePath);

            try {
                const stat = await fs.stat(tryPath);
                if (stat.isFile()) {
                    const data = await fs.readFile(tryPath);
                    if (isAborted) return;
                    
                    let mime = 'application/octet-stream';
                    if (tryPath.endsWith('.js')) mime = 'application/javascript';
                    else if (tryPath.endsWith('.css')) mime = 'text/css';
                    else if (tryPath.endsWith('.html')) mime = 'text/html';
                    
                    res.cork(() => {
                        res.writeHeader('content-type', mime);
                        res.end(data);
                    });
                } else {
                    if (isAborted) return;
                    res.writeStatus('404 Not Found').end();
                }
            } catch {
                if (isAborted) return;
                req.setYield(true); // fallthrough if file not found
            }
        });
    }

    async start(): Promise<void> {
        log.info('🚀 Starting SSR Server (uWebSockets.js)...');

        const manifest = await this.router.scanRoutes();
        log.info(`📋 Found ${manifest.routes.length} routes`);

        this.serveStatic('/assets', path.join(this.config.root, this.config.outDir));
        this.serveStatic('/public', path.join(this.config.root, 'public'));

        // Handle all unknown routes (acts as a catch-all router)
        this.app.any('/*', async (res, req) => {
            const mockReq = createMockReq(res, req);
            const mockRes = createMockRes(res);
            
            let isAborted = false;
            res.onAborted(() => { isAborted = true; });

            // 1. Check API Routes
            for (const route of manifest.apiRoutes) {
                let regexPath = route.path
                    .replace(/:(\w+)/g, '[^/]+')
                    .replace(/\*(\w+)/g, '.*');

                const routeRegex = new RegExp(`^${regexPath}$`);
                if (routeRegex.test(mockReq.path)) {
                    await this.handleAPIRoute(route, mockReq, mockRes);
                    return;
                }
            }

            // 2. Check Page Routes
            for (const route of manifest.pageRoutes) {
                let regexPath = route.path
                    .replace(/:(\w+)/g, '[^/]+')
                    .replace(/\*(\w+)/g, '.*');

                const routeRegex = new RegExp(`^${regexPath}$`);
                if (routeRegex.test(mockReq.path) && mockReq.method === 'GET') {
                    await this.handlePageRoute(route, mockReq, mockRes);
                    return;
                }
            }

            // 404 Fallback
            if (!isAborted && !mockRes.isTerminated) {
                mockRes.status(404).send(this.render404());
            }
        });

        return new Promise((resolve, reject) => {
            this.app.listen(this.config.port, (token) => {
                if (token) {
                    log.info(`✅ SSR Server running on http://localhost:${this.config.port}`);
                    log.info(`📦 Framework: ${this.config.framework}`);
                    resolve();
                } else {
                    reject(new Error(`Failed to listen to port ${this.config.port}`));
                }
            });
        });
    }

    private async handleAPIRoute(route: Route, req: any, res: any): Promise<void> {
        try {
            log.info(`🔌 API: ${req.method} ${req.path}`);
            const handler = await this.importRoute(route.filePath);

            if (typeof handler.default === 'function') {
                await handler.default(req, res);
            } else if (typeof handler === 'function') {
                await handler(req, res);
            } else {
                res.status(500).json({ error: 'Invalid API handler' });
            }
        } catch (error: any) {
            log.error(`❌ API Error: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    }

    private async handlePageRoute(route: Route, req: any, res: any): Promise<void> {
        try {
            log.info(`📄 Page: ${req.method} ${req.path}`);

            const match = this.router.match(req.path);
            if (!match) {
                res.status(404).send(this.render404());
                return;
            }

            const context: RenderContext = {
                route: match.route,
                req,
                res,
                params: match.params,
                query: match.query,
            };

            context.data = await this.fetchData(context);
            const html = await this.renderPage(context);
            res.status(200).send(html);
        } catch (error: any) {
            log.error(`❌ Render Error: ${error.message}`);
            res.status(500).send(this.render500(error));
        }
    }

    private async fetchData(context: RenderContext): Promise<any> {
        try {
            const module = await this.importRoute(context.route.filePath);

            if (this.config.framework === 'nextjs') {
                if (module.getServerSideProps) {
                    const result = await module.getServerSideProps({
                        req: context.req,
                        res: context.res,
                        params: context.params,
                        query: context.query,
                    });
                    return result.props;
                }
                if (module.getStaticProps) {
                    const result = await module.getStaticProps({
                        params: context.params,
                    });
                    return result.props;
                }
            }

            if (this.config.framework === 'remix') {
                if (context.req.method === 'GET' && module.loader) {
                    return await module.loader({
                        request: context.req,
                        params: context.params,
                    });
                }
                if (context.req.method === 'POST' && module.action) {
                    return await module.action({
                        request: context.req,
                        params: context.params,
                    });
                }
            }
            return {};
        } catch (error: any) {
            log.warn(`⚠️ Data fetch failed: ${error.message}`);
            return {};
        }
    }

    private async renderPage(context: RenderContext): Promise<string> {
        try {
            const Component = await this.importRoute(context.route.filePath);
            let appHtml = '';

            if (this.config.framework === 'nextjs') {
                appHtml = await this.renderReact(Component, context);
            } else if (this.config.framework === 'nuxt') {
                appHtml = await this.renderVue(Component, context);
            } else if (this.config.framework === 'remix') {
                appHtml = await this.renderReact(Component, context);
            }

            return this.wrapInDocument(appHtml, context);
        } catch (error: any) {
            log.error(`❌ Render failed: ${error.message}`);
            throw error;
        }
    }

    private async renderReact(Component: any, context: RenderContext): Promise<string> {
        await polyfillGlobalReact();
        const renderer = new ReactSSRRenderer();
        return await renderer.render(Component, context);
    }

    private async renderVue(Component: any, context: RenderContext): Promise<string> {
        const renderer = new VueSSRRenderer();
        return await renderer.render(Component, context);
    }

    private wrapInDocument(appHtml: string, context: RenderContext): string {
        const template = this.config.template || this.getDefaultTemplate();
        return template
            .replace('<!--app-html-->', appHtml)
            .replace('<!--app-data-->', `<script>window.__INITIAL_DATA__=${JSON.stringify(context.data)}</script>`)
            .replace('<!--app-title-->', `SSR App - ${context.route.name}`);
    }

    private getDefaultTemplate(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="lunx-version" content="PROD-READY-V1">
  <title><!--app-title--></title>
</head>
<body>
  <div id="lunx-root"><!--app-html--></div>
  <!--app-data-->
  <script type="module" src="/assets/entry0.js"></script>
</body>
</html>`;
    }

    private render404(): string {
        return `<!DOCTYPE html>
<html>
<head><title>404 - Not Found</title></head>
<body>
  <h1>404 - Page Not Found</h1>
  <p>The requested page does not exist.</p>
</body>
</html>`;
    }

    private render500(error: Error): string {
        return `<!DOCTYPE html>
<html>
<head><title>500 - Server Error</title></head>
<body>
  <h1>500 - Server Error</h1>
  <p>${this.config.production ? 'An error occurred.' : error.message}</p>
  ${this.config.production ? '' : `<pre>${error.stack}</pre>`}
</body>
</html>`;
    }

    private async importRoute(filePath: string): Promise<any> {
        try {
            if (this.config.production) {
                const buildPath = path.join(this.config.root, this.config.outDir, path.basename(filePath, path.extname(filePath)) + '.js');
                return await import(buildPath);
            }
            return await import(filePath);
        } catch (error: any) {
            log.error(`❌ Failed to import ${filePath}: ${error.message}`);
            throw error;
        }
    }
}
