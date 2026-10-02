/**
 * Zero-dependency WebSocket server (RFC 6455).
 *
 * Replaces the `ws` package for HMR and the dev dashboard. Implements the
 * server half of the protocol: handshake, frame codec, fragmentation,
 * close/ping/pong control frames and per-socket backpressure.
 *
 * Intentionally NOT implemented: client mode, permessage-deflate, subprotocol
 * negotiation beyond echoing one back. Nothing in Lunx uses them.
 */

import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';

/** Magic value from RFC 6455 §1.3, appended before hashing the client key. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

const enum Opcode {
    Continuation = 0x0,
    Text = 0x1,
    Binary = 0x2,
    Close = 0x8,
    Ping = 0x9,
    Pong = 0xa,
}

/** Max bytes we will buffer for a single (possibly fragmented) message. */
const DEFAULT_MAX_PAYLOAD = 100 * 1024 * 1024;

/** Matches the node stream write callback signature. */
type WriteCallback = (err?: Error | null) => void;

export interface WebSocketServerOptions {
    /** Attach to an existing HTTP server and handle its `upgrade` events. */
    server?: Server;
    /** Do not attach; the caller drives `handleUpgrade`. */
    noServer?: boolean;
    /** Only accept upgrades for this pathname. */
    path?: string;
    maxPayload?: number;
    /** Return false to reject the handshake. */
    verifyClient?: (info: { origin?: string; req: IncomingMessage }) => boolean;
}

export class WebSocket extends EventEmitter {
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;

    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = CLOSING;
    readonly CLOSED = CLOSED;

    readyState: number = OPEN;

    private readonly socket: Duplex;
    private readonly maxPayload: number;

    /** Bytes received but not yet forming a complete frame. */
    private buffer: Buffer = Buffer.alloc(0);
    /** Payload chunks of the message currently being assembled. */
    private fragments: Buffer[] = [];
    private fragmentedOpcode: Opcode | null = null;
    private fragmentedLength = 0;

    constructor(socket: Duplex, maxPayload = DEFAULT_MAX_PAYLOAD) {
        super();
        this.socket = socket;
        this.maxPayload = maxPayload;

        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('error', (err: Error) => {
            // A peer that vanished mid-write is routine, not fatal.
            this.emitError(err);
            this.terminate();
        });
        socket.on('close', () => this.finish());
        socket.on('end', () => this.finish());
    }

    // ── Public API ─────────────────────────────────────────────────────────

    // Typed events, so call sites get `Buffer` instead of `any` for message data.
    override on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
    override on(event: 'close', listener: (code: number, reason: string) => void): this;
    override on(event: 'error', listener: (err: Error) => void): this;
    override on(event: 'ping' | 'pong', listener: (data: Buffer) => void): this;
    override on(event: string, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    override once(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
    override once(event: 'close', listener: (code: number, reason: string) => void): this;
    override once(event: 'error', listener: (err: Error) => void): this;
    override once(event: 'ping' | 'pong', listener: (data: Buffer) => void): this;
    override once(event: string, listener: (...args: any[]) => void): this {
        return super.once(event, listener);
    }

    send(data: string | Buffer | ArrayBufferView, cb?: WriteCallback): void {
        if (this.readyState !== OPEN) {
            cb?.(new Error('WebSocket is not open'));
            return;
        }
        const isString = typeof data === 'string';
        const payload = isString
            ? Buffer.from(data, 'utf8')
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        this.writeFrame(isString ? Opcode.Text : Opcode.Binary, payload, cb);
    }

    ping(data?: Buffer): void {
        if (this.readyState !== OPEN) return;
        this.writeFrame(Opcode.Ping, data ?? Buffer.alloc(0));
    }

    pong(data?: Buffer): void {
        if (this.readyState !== OPEN) return;
        this.writeFrame(Opcode.Pong, data ?? Buffer.alloc(0));
    }

    close(code = 1000, reason = ''): void {
        if (this.readyState === CLOSING || this.readyState === CLOSED) return;
        this.readyState = CLOSING;
        const reasonBuf = Buffer.from(reason, 'utf8');
        const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);
        this.writeFrame(Opcode.Close, payload, () => this.socket.end());
        // Do not wait forever for the peer's close frame.
        const timer = setTimeout(() => this.terminate(), 5_000);
        timer.unref?.();
    }

    terminate(): void {
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        this.socket.destroy();
    }

    /**
     * EventEmitter throws when 'error' is emitted with no listener, which
     * would take the dev server down whenever a browser tab closed mid-write.
     */
    private emitError(err: Error): void {
        if (this.listenerCount('error') > 0) this.emit('error', err);
    }

    // ── Frame decoding ─────────────────────────────────────────────────────

    private onData(chunk: Buffer): void {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        try {
            while (this.decodeFrame()) {
                /* keep draining while whole frames remain */
            }
        } catch (err) {
            this.emitError(err as Error);
            this.terminate();
        }
    }

    /** Returns true when a frame was consumed, false when more bytes are needed. */
    private decodeFrame(): boolean {
        const buf = this.buffer;
        if (buf.length < 2) return false;

        const first = buf[0]!;
        const second = buf[1]!;
        const fin = (first & 0x80) !== 0;
        const rsv = first & 0x70;
        const opcode = (first & 0x0f) as Opcode;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        // RFC 6455 §5.2: reserved bits must be zero without a negotiated extension.
        if (rsv !== 0) throw new Error('Reserved bits must be clear');
        // RFC 6455 §5.1: every client-to-server frame must be masked.
        if (!masked) throw new Error('Client frames must be masked');

        if (length === 126) {
            if (buf.length < offset + 2) return false;
            length = buf.readUInt16BE(offset);
            offset += 2;
        } else if (length === 127) {
            if (buf.length < offset + 8) return false;
            const big = buf.readBigUInt64BE(offset);
            if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Frame too large');
            length = Number(big);
            offset += 8;
        }

        if (length > this.maxPayload) throw new Error('Max payload exceeded');
        if (buf.length < offset + 4 + length) return false;

        const mask = buf.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) payload[i] = buf[offset + i]! ^ mask[i & 3]!;
        this.buffer = buf.subarray(offset + length);

        this.handleFrame(fin, opcode, payload);
        return true;
    }

    private handleFrame(fin: boolean, opcode: Opcode, payload: Buffer): void {
        // Control frames may be injected between fragments and are never fragmented.
        if (opcode === Opcode.Close) {
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
            const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
            if (this.readyState === OPEN) {
                this.readyState = CLOSING;
                this.writeFrame(Opcode.Close, payload, () => this.socket.end());
            }
            this.closeCode = code;
            this.closeReason = reason;
            return;
        }
        if (opcode === Opcode.Ping) {
            this.pong(payload);
            this.emit('ping', payload);
            return;
        }
        if (opcode === Opcode.Pong) {
            this.emit('pong', payload);
            return;
        }

        if (opcode === Opcode.Continuation) {
            if (this.fragmentedOpcode === null) throw new Error('Unexpected continuation frame');
        } else {
            if (this.fragmentedOpcode !== null) throw new Error('Expected continuation frame');
            this.fragmentedOpcode = opcode;
        }

        this.fragmentedLength += payload.length;
        if (this.fragmentedLength > this.maxPayload) throw new Error('Max payload exceeded');
        this.fragments.push(payload);

        if (!fin) return;

        const full = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments, this.fragmentedLength);
        const messageOpcode = this.fragmentedOpcode;
        this.fragments = [];
        this.fragmentedOpcode = null;
        this.fragmentedLength = 0;

        // `ws` hands the raw Buffer to listeners plus an isBinary flag.
        this.emit('message', full, messageOpcode === Opcode.Binary);
    }

    // ── Frame encoding ─────────────────────────────────────────────────────

    private writeFrame(opcode: Opcode, payload: Buffer, cb?: WriteCallback): void {
        const length = payload.length;
        let header: Buffer;

        if (length < 126) {
            header = Buffer.allocUnsafe(2);
            header[1] = length;
        } else if (length < 65536) {
            header = Buffer.allocUnsafe(4);
            header[1] = 126;
            header.writeUInt16BE(length, 2);
        } else {
            header = Buffer.allocUnsafe(10);
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(length), 2);
        }
        header[0] = 0x80 | opcode; // FIN set: we never fragment outgoing frames.

        // A socket the peer already dropped throws synchronously on write.
        if (this.socket.destroyed || this.socket.writableEnded) {
            cb?.(new Error('Socket is closed'));
            return;
        }

        // Header and payload MUST go out in one write. Writing them separately
        // lets a second send() interleave its header between this frame's
        // header and payload, which corrupts the stream and makes browsers
        // drop the connection with 1006.
        const frame = length === 0 ? header : Buffer.concat([header, payload], header.length + length);

        try {
            // Server-to-client frames are never masked (RFC 6455 §5.1).
            this.socket.write(frame, cb);
        } catch (writeErr) {
            cb?.(writeErr as Error);
        }
    }

    private closeCode = 1006;
    private closeReason = '';

    private finished = false;
    private finish(): void {
        if (this.finished) return;
        this.finished = true;
        this.readyState = CLOSED;
        this.emit('close', this.closeCode, this.closeReason);
    }
}

export class WebSocketServer extends EventEmitter {
    readonly clients = new Set<WebSocket>();
    readonly options: WebSocketServerOptions;

    private readonly server?: Server;
    private readonly onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

    // Typed events, so `ws` in a connection handler is a WebSocket rather than `any`.
    override on(event: 'connection', listener: (ws: WebSocket, req: IncomingMessage) => void): this;
    override on(event: 'error', listener: (err: Error) => void): this;
    override on(event: 'close' | 'listening', listener: () => void): this;
    override on(event: string, listener: (...args: any[]) => void): this {
        return super.on(event, listener);
    }

    constructor(options: WebSocketServerOptions = {}) {
        super();
        this.options = options;

        if (options.server) {
            this.server = options.server;
            this.onUpgrade = (req, socket, head) => {
                if (options.path) {
                    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
                    // Another WebSocketServer may own this path; leave the socket alone.
                    if (pathname !== options.path) return;
                }
                this.handleUpgrade(req, socket, head, (ws) => this.emit('connection', ws, req));
            };
            this.server.on('upgrade', this.onUpgrade);
        }
    }

    handleUpgrade(
        req: IncomingMessage,
        socket: Duplex,
        _head: Buffer,
        callback: (ws: WebSocket, req: IncomingMessage) => void,
    ): void {
        const key = req.headers['sec-websocket-key'];
        const version = req.headers['sec-websocket-version'];
        const upgrade = String(req.headers.upgrade ?? '').toLowerCase();

        if (upgrade !== 'websocket' || typeof key !== 'string' || version !== '13') {
            abort(socket, 400, 'Bad Request');
            return;
        }
        if (this.options.verifyClient && !this.options.verifyClient({ origin: req.headers.origin, req })) {
            abort(socket, 401, 'Unauthorized');
            return;
        }

        const accept = createHash('sha1').update(key + GUID).digest('base64');
        // Browsers drop the connection unless a requested subprotocol is echoed back.
        const protocol = String(req.headers['sec-websocket-protocol'] ?? '').split(',')[0]!.trim();
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') +
                `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );

        // Nagle would add latency to the small JSON frames HMR sends.
        (socket as Socket).setNoDelay?.(true);
        (socket as Socket).setTimeout?.(0);

        const ws = new WebSocket(socket, this.options.maxPayload ?? DEFAULT_MAX_PAYLOAD);
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        // Guarantees a listener exists, so a socket error can never be fatal.
        ws.on('error', (err) => {
            this.clients.delete(ws);
            if (this.listenerCount('error') > 0) this.emit('error', err);
        });
        callback(ws, req);
    }

    close(cb?: (err?: Error) => void): void {
        for (const client of this.clients) client.terminate();
        this.clients.clear();
        if (this.server && this.onUpgrade) this.server.off('upgrade', this.onUpgrade);
        this.emit('close');
        cb?.();
    }

    /** Broadcasts to every open client. Not part of `ws`; convenient and avoids a forEach at each call site. */
    broadcast(data: string | Buffer): void {
        for (const client of this.clients) {
            // Ignore per-client failures: one dead tab must not stop the rest.
            if (client.readyState === OPEN) client.send(data, () => {});
        }
    }
}

function abort(socket: Duplex, code: number, message: string): void {
    socket.write(
        `HTTP/1.1 ${code} ${message}\r\n` +
            'Connection: close\r\n' +
            'Content-Type: text/plain\r\n' +
            `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n` +
            message,
    );
    socket.destroy();
}

/** Generates a client-side masking key; exported for tests. */
export function maskingKey(): Buffer {
    return randomBytes(4);
}

export default WebSocketServer;
