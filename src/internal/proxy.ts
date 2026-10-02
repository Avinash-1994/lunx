/**
 * Zero-dependency HTTP/WebSocket proxy, replacing `http-proxy`.
 *
 * Covers the dev-server use: forward a request (or an upgrade) to a target
 * origin, stream both directions, rewrite the path, and set the forwarding
 * headers. API-compatible with the `createProxyServer().web()/.ws()` calls
 * the dev server and the Astro adapter make.
 */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { IncomingMessage, ServerResponse, ClientRequest } from 'node:http';
import type { Duplex } from 'node:stream';

export interface ProxyOptions {
    /** Origin to forward to, e.g. `http://127.0.0.1:8080`. */
    target?: string | URL;
    /** Rewrite the Host header to the target's host. */
    changeOrigin?: boolean;
    /** Enable WebSocket upgrade forwarding. */
    ws?: boolean;
    /** Rewrite the request path before forwarding. */
    rewrite?: (path: string) => string;
    /** Legacy `http-proxy` path rewriting: longest matching prefix wins. */
    pathRewrite?: Record<string, string> | ((path: string) => string);
    /** Reject self-signed certificates on an https target. Default false, as in dev. */
    secure?: boolean;
    /** Milliseconds before an upstream request is abandoned. */
    timeout?: number;
    /** Extra headers added to the proxied request. */
    headers?: Record<string, string>;
    /** Accepted for API compatibility; responses are always streamed through. */
    selfHandleResponse?: boolean;
    /** Follow 3xx from the target instead of passing them to the client. */
    followRedirects?: boolean;
}

/** Hop-by-hop headers must not be forwarded (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function resolveTarget(target: string | URL | undefined): URL {
    if (!target) throw new Error('Proxy target is required');
    return typeof target === 'string' ? new URL(target) : target;
}

function applyRewrite(path: string, options: ProxyOptions): string {
    if (options.rewrite) return options.rewrite(path);
    const rules = options.pathRewrite;
    if (!rules) return path;
    if (typeof rules === 'function') return rules(path);
    // Longest prefix wins, so `/api/v2` beats `/api`.
    const match = Object.keys(rules)
        .filter((prefix) => new RegExp(prefix).test(path))
        .sort((a, b) => b.length - a.length)[0];
    return match === undefined ? path : path.replace(new RegExp(match), rules[match]!);
}

function forwardableHeaders(req: IncomingMessage, targetUrl: URL, options: ProxyOptions): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        if (value !== undefined) headers[key] = value;
    }
    if (options.changeOrigin) headers.host = targetUrl.host;

    // Standard forwarding headers, appended rather than replaced.
    const remote = req.socket.remoteAddress ?? '';
    const existing = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = existing ? `${existing}, ${remote}` : remote;
    headers['x-forwarded-host'] ??= req.headers.host ?? '';
    headers['x-forwarded-proto'] ??= (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http';

    Object.assign(headers, options.headers ?? {});
    return headers;
}

export class ProxyServer extends EventEmitter {
    constructor(private readonly defaults: ProxyOptions = {}) {
        super();
    }

    /** Forwards an ordinary HTTP request. */
    web(req: IncomingMessage, res: ServerResponse, overrides: ProxyOptions = {}, callback?: (err: Error) => void): void {
        const options = { ...this.defaults, ...overrides };
        let targetUrl: URL;
        try {
            targetUrl = resolveTarget(options.target);
        } catch (err) {
            this.reportError(err as Error, req, res, callback);
            return;
        }

        const path = applyRewrite(req.url ?? '/', options);
        // A target may carry a base path (http://host/base) that prefixes the request path.
        const basePath = targetUrl.pathname.replace(/\/$/, '');
        const transport = targetUrl.protocol === 'https:' ? https : http;

        const upstream: ClientRequest = transport.request(
            {
                protocol: targetUrl.protocol,
                hostname: targetUrl.hostname,
                port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
                method: req.method,
                path: basePath + path,
                headers: forwardableHeaders(req, targetUrl, options),
                rejectUnauthorized: options.secure ?? false,
                timeout: options.timeout,
            },
            (upstreamRes) => {
                this.emit('proxyRes', upstreamRes, req, res);
                if (res.headersSent) {
                    upstreamRes.destroy();
                    return;
                }
                const headers = { ...upstreamRes.headers };
                for (const key of Object.keys(headers)) {
                    if (HOP_BY_HOP.has(key.toLowerCase())) delete headers[key];
                }
                res.writeHead(upstreamRes.statusCode ?? 502, headers);
                upstreamRes.pipe(res);
                upstreamRes.on('error', (err) => this.reportError(err, req, res, callback));
            },
        );

        upstream.on('error', (err) => this.reportError(err, req, res, callback));
        if (options.timeout) {
            upstream.on('timeout', () => {
                upstream.destroy();
                this.reportError(new Error(`Proxy timeout after ${options.timeout}ms`), req, res, callback);
            });
        }

        this.emit('proxyReq', upstream, req, res, options);
        // Stream the body rather than buffering, so uploads do not sit in memory.
        req.pipe(upstream);
        req.on('error', () => upstream.destroy());
    }

    /** Forwards a WebSocket upgrade, then pipes the two sockets together. */
    ws(req: IncomingMessage, socket: Duplex, head: Buffer, overrides: ProxyOptions = {}, callback?: (err: Error) => void): void {
        const options = { ...this.defaults, ...overrides };
        let targetUrl: URL;
        try {
            targetUrl = resolveTarget(options.target);
        } catch (err) {
            this.reportError(err as Error, req, undefined, callback);
            socket.destroy();
            return;
        }

        const path = applyRewrite(req.url ?? '/', options);
        const basePath = targetUrl.pathname.replace(/\/$/, '');
        const transport = targetUrl.protocol === 'https:' || targetUrl.protocol === 'wss:' ? https : http;

        const headers = forwardableHeaders(req, targetUrl, options);
        // The upgrade handshake needs exactly these hop-by-hop headers back.
        headers.connection = 'Upgrade';
        headers.upgrade = 'websocket';

        const upstream = transport.request({
            hostname: targetUrl.hostname,
            port: targetUrl.port || (transport === https ? 443 : 80),
            method: req.method,
            path: basePath + path,
            headers,
            rejectUnauthorized: options.secure ?? false,
        });

        upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
            const statusLine = [
                'HTTP/1.1 101 Switching Protocols',
                ...Object.entries(upstreamRes.headers).flatMap(([key, value]) =>
                    Array.isArray(value) ? value.map((v) => `${key}: ${v}`) : value === undefined ? [] : [`${key}: ${value}`],
                ),
                '',
                '',
            ].join('\r\n');

            socket.write(statusLine);
            if (upstreamHead?.length) socket.write(upstreamHead);
            if (head?.length) upstreamSocket.write(head);

            // Small frames: disable Nagle on both ends so HMR stays responsive.
            (socket as net.Socket).setNoDelay?.(true);
            upstreamSocket.setNoDelay?.(true);

            upstreamSocket.on('error', () => socket.destroy());
            socket.on('error', () => upstreamSocket.destroy());
            socket.pipe(upstreamSocket).pipe(socket);
            this.emit('open', upstreamSocket);
        });

        upstream.on('response', (upstreamRes) => {
            // The target refused to upgrade; relay its answer and close.
            if (!socket.destroyed) {
                socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n\r\n`);
                upstreamRes.pipe(socket);
            }
        });

        upstream.on('error', (err) => {
            this.reportError(err, req, undefined, callback);
            socket.destroy();
        });

        upstream.end();
    }

    /** `http-proxy` also exposes `listen()`; provided for parity. */
    listen(port: number, hostname?: string): http.Server {
        const server = http.createServer((req, res) => this.web(req, res));
        if (this.defaults.ws) {
            server.on('upgrade', (req, socket, head) => this.ws(req, socket as Duplex, head));
        }
        server.listen(port, hostname);
        return server;
    }

    close(): void {
        this.emit('close');
    }

    private reportError(
        err: Error,
        req: IncomingMessage,
        res: ServerResponse | undefined,
        callback?: (err: Error) => void,
    ): void {
        if (callback) {
            callback(err);
            return;
        }
        // Matches http-proxy: listeners get (err, req, res); with none, answer 502.
        if (this.listenerCount('error') > 0) {
            this.emit('error', err, req, res);
            return;
        }
        if (res && !res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Proxy error: ${err.message}`);
        }
    }
}

export function createProxyServer(options: ProxyOptions = {}): ProxyServer {
    return new ProxyServer(options);
}

export default { createProxyServer, ProxyServer };
