/**
 * A connect-compatible middleware stack: `use(route?, handle)`, `stack`,
 * error middlewares (four arguments), route prefix stripping and
 * `req.originalUrl` — what Vite's `server.middlewares` exposes to plugins.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';

export type NextFunction = (err?: any) => void;
export type Handle = ((req: any, res: any, next: NextFunction) => void) | ((err: any, req: any, res: any, next: NextFunction) => void);

export interface Connect {
    (req: IncomingMessage, res: ServerResponse, next?: NextFunction): void;
    stack: Array<{ route: string; handle: Handle }>;
    use(route: string | Handle, handle?: Handle): Connect;
    handle(req: IncomingMessage, res: ServerResponse, out?: NextFunction): void;
    /** connect's `app.listen(...)`: an HTTP server running this stack. */
    listen(...args: any[]): http.Server;
}

export function createConnect(): Connect {
    const app = function (req: IncomingMessage, res: ServerResponse, next?: NextFunction) {
        app.handle(req, res, next);
    } as Connect;
    app.stack = [];

    app.use = (route: string | Handle, handle?: Handle) => {
        let path = '/';
        let fn = handle;
        if (typeof route !== 'string') fn = route;
        else path = route;
        if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
        app.stack.push({ route: path === '/' ? '' : path, handle: fn! });
        return app;
    };

    app.handle = (req: any, res: ServerResponse, out?: NextFunction) => {
        let index = 0;
        let removed = '';
        req.originalUrl = req.originalUrl || req.url;

        const next = (err?: any): void => {
            if (removed) {
                req.url = removed + req.url;
                removed = '';
            }
            const layer = app.stack[index++];
            if (!layer) {
                setImmediate(() => (out ? out(err) : finalHandler(err, req, res)));
                return;
            }
            const pathname = (req.url || '/').split('?')[0];
            const route = layer.route;
            if (route) {
                if (!pathname.toLowerCase().startsWith(route.toLowerCase())) return next(err);
                const c = pathname[route.length];
                if (c !== undefined && c !== '/' && c !== '.') return next(err);
                removed = route;
                req.url = req.url.slice(route.length) || '/';
                if (!req.url.startsWith('/')) req.url = '/' + req.url;
            }
            call(layer.handle, err, req, res, next);
        };
        next();
    };

    app.listen = (...args: any[]) => http.createServer(app).listen(...args);

    return app;
}

function call(handle: Handle, err: any, req: any, res: any, next: NextFunction): void {
    const arity = handle.length;
    let error = err;
    const hasError = err !== undefined && err !== null;
    try {
        if (hasError && arity === 4) {
            const r = (handle as any)(err, req, res, next);
            if (r && typeof r.catch === 'function') r.catch(next);
            return;
        }
        if (!hasError && arity < 4) {
            const r = (handle as any)(req, res, next);
            if (r && typeof r.catch === 'function') r.catch(next);
            return;
        }
    } catch (e) {
        error = e;
    }
    next(error);
}

function finalHandler(err: any, req: any, res: ServerResponse): void {
    if (res.headersSent || res.writableEnded) return;
    if (err) {
        res.statusCode = err.status || err.statusCode || 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(err.stack || String(err));
        return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Cannot ${req.method} ${req.originalUrl}`);
}
