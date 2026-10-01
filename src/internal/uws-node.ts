/**
 * A node:http implementation of the slice of the uWebSockets.js `App()` API
 * that the SSR server uses.
 *
 * uWebSockets.js ships only as a git dependency, which breaks `npm ci` in
 * locked-down and offline environments, so Lunx does not declare it. Before
 * this existed, `lunx ssr` simply refused to start without it — an advertised
 * feature that no default install could reach. The fast path is still real
 * uWS when the user has installed it; this is the floor.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HttpRequest, HttpResponse, TemplatedApp } from './uws.js';

type Handler = (res: HttpResponse, req: HttpRequest) => void | Promise<void>;
type Route = { method: string; pattern: string; handler: Handler };

/**
 * uWS patterns: `/*` matches any suffix, `:name` matches one path segment.
 * Returns the matched parameters, or null when the route does not apply.
 */
function matchPattern(pattern: string, pathname: string): string[] | null {
    if (pattern === '/*' || pattern === '*') return [];

    const wildcard = pattern.endsWith('/*');
    const base = wildcard ? pattern.slice(0, -2) : pattern;
    const patternParts = base.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);

    if (wildcard ? pathParts.length < patternParts.length : pathParts.length !== patternParts.length) {
        return null;
    }

    const params: string[] = [];
    for (let i = 0; i < patternParts.length; i++) {
        const p = patternParts[i];
        if (p.startsWith(':')) {
            params.push(pathParts[i]);
        } else if (p !== pathParts[i]) {
            return null;
        }
    }
    return params;
}

function wrapRequest(req: IncomingMessage, params: string[]): HttpRequest {
    const raw = req.url ?? '/';
    const qIndex = raw.indexOf('?');
    const pathname = qIndex === -1 ? raw : raw.slice(0, qIndex);
    const query = qIndex === -1 ? '' : raw.slice(qIndex + 1);
    let yielded = false;

    const wrapped: HttpRequest = {
        getHeader(name: string) {
            const v = req.headers[name.toLowerCase()];
            return Array.isArray(v) ? v.join(', ') : (v ?? '');
        },
        // uWS reports the method lowercased.
        getMethod: () => (req.method ?? 'get').toLowerCase(),
        getUrl: () => pathname,
        getQuery: () => query,
        getParameter: (index: number) => params[index] ?? '',
        forEach(cb: (key: string, value: string) => void) {
            for (const [key, value] of Object.entries(req.headers)) {
                cb(key, Array.isArray(value) ? value.join(', ') : String(value ?? ''));
            }
        },
        setYield(shouldYield: boolean) {
            yielded = shouldYield;
            return wrapped;
        },
        get __yielded() {
            return yielded;
        },
    };
    return wrapped;
}

function wrapResponse(res: ServerResponse): HttpResponse {
    let status = 200;
    let statusText: string | undefined;
    const headers: Record<string, string> = {};
    let headersSent = false;
    let ended = false;
    const abortHandlers: Array<() => void> = [];

    const flush = () => {
        if (headersSent) return;
        headersSent = true;
        // uWS takes a full status line ("404 Not Found"); node wants them apart.
        res.writeHead(status, statusText, headers);
    };

    const wrapped: HttpResponse = {
        writeStatus(line: string) {
            const space = line.indexOf(' ');
            status = parseInt(space === -1 ? line : line.slice(0, space), 10) || 200;
            statusText = space === -1 ? undefined : line.slice(space + 1);
            return wrapped;
        },
        writeHeader(key: string, value: string) {
            headers[key] = value;
            return wrapped;
        },
        write(chunk) {
            flush();
            return res.write(toNodeChunk(chunk));
        },
        end(body) {
            if (ended) return wrapped;
            ended = true;
            flush();
            res.end(body === undefined ? undefined : toNodeChunk(body));
            return wrapped;
        },
        onAborted(handler: () => void) {
            abortHandlers.push(handler);
            return wrapped;
        },
        onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void) {
            const req = (res as ServerResponse & { req: IncomingMessage }).req;
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
                const joined = Buffer.concat(chunks);
                handler(
                    joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.byteLength) as ArrayBuffer,
                    true,
                );
            });
            return wrapped;
        },
        // uWS batches writes inside cork(); node already buffers, so run it.
        cork(cb: () => void) {
            cb();
            return wrapped;
        },
        getRemoteAddressAsText() {
            const addr = (res as ServerResponse & { req: IncomingMessage }).req.socket.remoteAddress ?? '';
            return Buffer.from(addr).buffer as ArrayBuffer;
        },
        get __ended() {
            return ended;
        },
    };

    const onAbort = () => {
        if (ended) return;
        ended = true;
        for (const h of abortHandlers) {
            try {
                h();
            } catch {}
        }
    };
    res.on('close', onAbort);

    return wrapped;
}

function toNodeChunk(chunk: string | ArrayBuffer | ArrayBufferView): string | Buffer {
    if (typeof chunk === 'string') return chunk;
    if (Buffer.isBuffer(chunk)) return chunk;
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return Buffer.from(chunk);
}

/** Builds a uWS-shaped app backed by node:http. */
export function createNodeApp(): TemplatedApp {
    const routes: Route[] = [];
    let server: Server | undefined;

    const add = (method: string) => (pattern: string, handler: Handler) => {
        routes.push({ method, pattern, handler });
        return app;
    };

    const app: TemplatedApp = {
        get: add('get'),
        post: add('post'),
        put: add('put'),
        del: add('delete'),
        patch: add('patch'),
        options: add('options'),
        head: add('head'),
        any: add('any'),
        ws() {
            // The SSR server does not use WebSockets; the dev server has its
            // own RFC 6455 implementation in src/internal/ws.ts.
            return app;
        },
        listen(...args: unknown[]) {
            // uWS accepts (port, cb) and (host, port, cb).
            const cb = args[args.length - 1] as (token: unknown) => void;
            const port = typeof args[0] === 'number' ? args[0] : (args[1] as number);
            const host = typeof args[0] === 'string' ? (args[0] as string) : undefined;

            server = createServer(async (req, res) => {
                const raw = req.url ?? '/';
                const qIndex = raw.indexOf('?');
                const pathname = qIndex === -1 ? raw : raw.slice(0, qIndex);
                const method = (req.method ?? 'GET').toLowerCase();

                for (const route of routes) {
                    if (route.method !== 'any' && route.method !== method) continue;
                    const params = matchPattern(route.pattern, pathname);
                    if (params === null) continue;

                    const wrappedReq = wrapRequest(req, params);
                    const wrappedRes = wrapResponse(res);
                    try {
                        await route.handler(wrappedRes, wrappedReq);
                    } catch (err) {
                        if (!(wrappedRes as { __ended?: boolean }).__ended) {
                            res.writeHead(500, { 'Content-Type': 'text/plain' });
                            res.end(`SSR handler failed: ${(err as Error)?.message ?? err}`);
                        }
                        return;
                    }
                    // setYield(true) asks the router to try the next match.
                    if ((wrappedReq as { __yielded?: boolean }).__yielded) continue;
                    return;
                }

                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            });

            server.on('error', () => cb(null));
            // A truthy token means "listening" to uWS callers.
            server.listen(port, host, () => cb(server));
            return app;
        },
        close() {
            server?.close();
        },
    };

    return app;
}

export default { createNodeApp };
