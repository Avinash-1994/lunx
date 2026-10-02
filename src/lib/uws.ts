/**
 * Optional loader for uWebSockets.js.
 *
 * uWebSockets.js is distributed only as a git dependency, which breaks
 * `npm ci` in locked-down and offline environments, so Lunx no longer declares
 * it. When a user installs it themselves we use the fast path; otherwise the
 * caller falls back to node:http.
 */

import { createRequire } from 'node:module';
import { createNodeApp } from './uws-node.js';

/** Structural types, so we do not need the package installed to typecheck. */
export interface HttpResponse {
    end(body?: string | ArrayBuffer | ArrayBufferView): HttpResponse;
    write(chunk: string | ArrayBuffer | ArrayBufferView): boolean;
    writeStatus(status: string): HttpResponse;
    writeHeader(key: string, value: string): HttpResponse;
    onAborted(handler: () => void): HttpResponse;
    onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void): HttpResponse;
    cork(cb: () => void): HttpResponse;
    getRemoteAddressAsText(): ArrayBuffer;
    [key: string]: unknown;
}

export interface HttpRequest {
    getHeader(name: string): string;
    getMethod(): string;
    getUrl(): string;
    getQuery(): string;
    getParameter(index: number): string;
    forEach(cb: (key: string, value: string) => void): void;
    /** Hands the request back to the router so a later handler can serve it. */
    setYield(shouldYield: boolean): HttpRequest;
    [key: string]: unknown;
}

export interface TemplatedApp {
    get(pattern: string, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    post(pattern: string, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    any(pattern: string, handler: (res: HttpResponse, req: HttpRequest) => void): TemplatedApp;
    listen(port: number, cb: (token: unknown) => void): TemplatedApp;
    ws(pattern: string, behavior: Record<string, unknown>): TemplatedApp;
    close?(): void;
    [key: string]: unknown;
}

export interface UWSModule {
    App(options?: Record<string, unknown>): TemplatedApp;
    SSLApp(options: Record<string, unknown>): TemplatedApp;
    us_listen_socket_close(token: unknown): void;
    [key: string]: unknown;
}

let cached: UWSModule | null | undefined;

/** Returns the module, or null when the user has not installed it. */
export function tryLoadUWS(): UWSModule | null {
    if (cached !== undefined) return cached;
    try {
        // createRequire because uWebSockets.js is CJS-only.
        const req = createRequire(import.meta.url);
        cached = req('uWebSockets.js') as UWSModule;
    } catch {
        cached = null;
    }
    return cached;
}

/**
 * Returns uWebSockets.js when installed, otherwise a node:http implementation
 * of the same API. This used to throw, which meant `lunx ssr` refused to start
 * on any install without the git dependency — an advertised feature that no
 * default install could reach.
 */
export function loadUWS(): UWSModule {
    return tryLoadUWS() ?? nodeFallbackModule();
}

/** True when the real native backend is in use rather than the node fallback. */
export function isNativeUWS(): boolean {
    return tryLoadUWS() !== null;
}

let fallback: UWSModule | undefined;

function nodeFallbackModule(): UWSModule {
    if (fallback) return fallback;
    fallback = {
        App: () => createNodeApp(),
        // TLS termination belongs in front of the node fallback (a proxy or a
        // platform load balancer), so SSLApp is the plain app.
        SSLApp: () => createNodeApp(),
        us_listen_socket_close: (token: unknown) => {
            (token as { close?: () => void } | null)?.close?.();
        },
    };
    return fallback;
}

export default { loadUWS, tryLoadUWS, isNativeUWS };
