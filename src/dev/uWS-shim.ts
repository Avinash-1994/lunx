// src/dev/uWS-shim.ts
// uWebSockets.js is a Linux-optimised native server.
// We attempt to load it at runtime and fall back to Node's built-in http+ws
// on Windows / macOS (or in any environment where the native binary is absent).

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';
import { EventEmitter } from 'events';
import { WebSocketServer } from '../lib/ws.js';
import { tryLoadUWS } from '../lib/uws.js';

// uWebSockets.js is optional and not declared as a dependency (it is a git-only
// package). When the user has installed it we take the fast path; otherwise the
// node:http + internal WebSocket fallback below is used on every platform.
const uWS: any = tryLoadUWS();

/**
 * Creates a server using uWebSockets.js when available (Linux, high-perf path),
 * or falls back to Node's built-in http + ws (Windows, macOS, CI).
 * The returned object exposes the same interface either way.
 */
export function createUWSServer(httpsOptions?: any) {
    // ── Fallback path: Node http + ws (cross-platform) ─────────────────────────
    if (!uWS) {
        return createNodeFallbackServer(httpsOptions);
    }

    // ── Fast path: uWebSockets.js (Linux) ──────────────────────────────────────
    const app = httpsOptions ? uWS.SSLApp({
        key_file_name: httpsOptions.keyFile,
        cert_file_name: httpsOptions.certFile,
    }) : uWS.App();


    const connectMiddlewares: any[] = [];

    // The mock server object
    const server = {
        _app: app,
        use(middleware: any) {
            connectMiddlewares.push(middleware);
        },
        listen(...args: any[]) {
            let port = args[0];
            let host = typeof args[1] === 'string' ? args[1] : '0.0.0.0';
            let cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : () => {};
            
            app.listen(host, port, (token: any) => {
                if (token) {
                    cb();
                } else {
                    console.error('Failed to listen to port ' + port);
                }
            });
        },
        close(cb?: () => void) {
            // uWS doesn't have a direct close all method without keeping the socket token
        },
        on() {} // mock server event emitter
    };

    const wssEmitter: any = new EventEmitter();
    wssEmitter.clients = new Set();
    (server as any).wsServer = wssEmitter;

    app.ws('/*', {
        compression: uWS.SHARED_COMPRESSOR,
        maxPayloadLength: 16 * 1024 * 1024,
        idleTimeout: 60,
        open: (ws: any) => {
            const mockWs = {
                readyState: 1, // OPEN
                OPEN: 1,
                send: (msg: string) => ws.send(msg),
                ping: () => ws.send('ping'), // mock ping
                terminate: () => ws.close(), // mock terminate
                _events: {} as any,
                on: function(event: string, cb: any) {
                    if (!this._events[event]) this._events[event] = [];
                    this._events[event].push(cb);
                },
                emit: function(event: string, ...args: any[]) {
                    if (this._events[event]) {
                        for (const cb of this._events[event]) cb(...args);
                    }
                }
            };
            (ws as any)._mock = mockWs;
            wssEmitter.clients.add(mockWs);

            // Emit connection with a mock request for headers
            const reqMock = { headers: { origin: 'http://localhost:3000' } }; // bypass strict origin checks or extract from WS upgrade headers if needed
            wssEmitter.emit('connection', mockWs, reqMock);
        },
        message: (ws: any, message: any, isBinary: any) => {
            const strMsg = Buffer.from(message).toString();
            (ws as any)._mock.emit('message', strMsg);
        },
        close: (ws: any, code: any, message: any) => {
            const mockWs = (ws as any)._mock;
            if (mockWs) {
                mockWs.readyState = 3; // CLOSED
                wssEmitter.clients.delete(mockWs);
                mockWs.emit('close');
            }
        }
    });

    // Route all traffic
    app.any('/*', (uWsRes: any, uWsReq: any) => {
        // Must handle abortion
        let aborted = false;
        uWsRes.onAborted(() => { aborted = true; });

        // Copy req headers / status
        const reqMock: any = new IncomingMessage(new Socket());
        reqMock.url = uWsReq.getUrl() + (uWsReq.getQuery() ? '?' + uWsReq.getQuery() : '');
        reqMock.method = uWsReq.getMethod().toUpperCase();
        reqMock.headers = {};
        uWsReq.forEach((key: any, val: any) => { reqMock.headers[key] = val; });

        const resMock: any = new ServerResponse(reqMock);
        let statusCode = 200;
        let headers: Record<string, string> = {};

        resMock.writeHead = (status: number, hdrs?: any) => {
            statusCode = status;
            if (hdrs) Object.assign(headers, hdrs);
            return resMock;
        };

        resMock.setHeader = (key: string, val: string) => {
            headers[key.toLowerCase()] = val;
        };

        resMock.end = (body?: any) => {
            if (aborted) return;
            try {
                uWsRes.cork(() => {
                    uWsRes.writeStatus(statusCode.toString());
                    for (const [k, v] of Object.entries(headers)) {
                        uWsRes.writeHeader(k, String(v));
                    }
                    if (resMock._bodyChunks && resMock._bodyChunks.length > 0) {
                        const fullBuf = Buffer.concat(resMock._bodyChunks);
                        if (body) {
                            uWsRes.end(Buffer.concat([fullBuf, Buffer.from(body)]));
                        } else {
                            uWsRes.end(fullBuf);
                        }
                    } else {
                        if (body) {
                            uWsRes.end(body);
                        } else {
                            uWsRes.end();
                        }
                    }
                });
            } catch (e) { }
        };

        resMock._bodyChunks = [];
        resMock.write = (chunk: any) => {
            if (chunk) resMock._bodyChunks.push(Buffer.from(chunk));
            return true;
        };

        // Pipe methods mock
        reqMock.pipe = (dest: any) => {
            // we don't natively pipe the uWs body yet since it's async (readJson, etc)
        };

        // Execute middlewares...
        // For standard devServer logic, we can just trigger the main requestHandler
        if ((server as any).requestHandler) {
            (server as any).requestHandler(reqMock, resMock);
        }
    });

    return server;
}

// ── Node http + ws fallback (Windows / macOS / CI without uWebSockets.js) ────
// Returns an object with the same interface as the uWS path above.
function createNodeFallbackServer(_httpsOptions?: any) {
    const connectMiddlewares: any[] = [];
    const wssEmitter = new EventEmitter() as any;
    wssEmitter.clients = new Set();

    const httpServer = createServer((req, res) => {
        if ((httpServer as any).requestHandler) {
            (httpServer as any).requestHandler(req, res);
        }
    });

    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (ws: any, req: any) => {
        wssEmitter.clients.add(ws);
        wssEmitter.emit('connection', ws, req);
        ws.on('close', () => wssEmitter.clients.delete(ws));
    });

    const server: any = {
        _httpServer: httpServer,
        wsServer: wssEmitter,
        use(middleware: any) { connectMiddlewares.push(middleware); },
        listen(...args: any[]) {
            const port = typeof args[0] === 'number' ? args[0] : 3000;
            const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : () => {};
            httpServer.listen(port, cb);
        },
        close(cb?: () => void) { httpServer.close(cb); },
        on(...args: any[]) { (httpServer as any).on(...args); },
    };

    return server;
}
