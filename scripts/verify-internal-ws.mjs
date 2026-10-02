/**
 * Interop check: our zero-dependency WebSocket server against the reference
 * `ws` client. Run with: node --import tsx scripts/verify-internal-ws.mjs
 */
import http from 'node:http';
import { WebSocketServer } from '../src/lib/ws.ts';
import WsClient from 'ws';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const server = http.createServer((_req, res) => res.end('ok'));
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            ws.send(data); // echo binary
        } else {
            ws.send(`echo:${data.toString('utf8')}`);
        }
    });
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const client = new WsClient(`ws://127.0.0.1:${port}`);
await new Promise((resolve, reject) => {
    client.on('open', resolve);
    client.on('error', reject);
});
check('handshake accepted by ws client', true);

function roundTrip(payload, binary = false) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        client.once('message', (data) => {
            clearTimeout(timer);
            resolve(binary ? data : data.toString('utf8'));
        });
        client.send(payload, { binary });
    });
}

// Short frame (7-bit length)
check('short text frame', (await roundTrip('hello')) === 'echo:hello');

// Medium frame (16-bit extended length)
const medium = 'x'.repeat(1000);
check('1KB frame (16-bit length)', (await roundTrip(medium)) === `echo:${medium}`);

// Large frame (64-bit extended length)
const large = 'y'.repeat(70_000);
check('70KB frame (64-bit length)', (await roundTrip(large)) === `echo:${large}`);

// Binary frame
const bin = Buffer.from([0, 1, 2, 250, 255]);
const back = await roundTrip(bin, true);
check('binary frame', Buffer.compare(Buffer.from(back), bin) === 0);

// UTF-8 multibyte
check('utf-8 multibyte', (await roundTrip('héllo — 世界 🚀')) === 'echo:héllo — 世界 🚀');

// Ping / pong initiated by the client
const pongOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    client.once('pong', () => {
        clearTimeout(timer);
        resolve(true);
    });
    client.ping();
});
check('client ping -> server pong', pongOk);

// Server-initiated broadcast reaches the client
const broadcastOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 3000);
    client.once('message', (d) => {
        clearTimeout(timer);
        resolve(d.toString('utf8') === 'broadcast');
    });
    wss.broadcast('broadcast');
});
check('server broadcast', broadcastOk);
check('clients set tracks 1 connection', wss.clients.size === 1, `size=${wss.clients.size}`);

// Regression: several sends issued back to back in one tick must not interleave
// their headers and payloads on the wire (that corrupts the stream, and the
// browser drops the connection with 1006).
const burstOk = await new Promise((resolve) => {
    const expected = Array.from({ length: 25 }, (_, i) => `burst-${i}-${'p'.repeat(i * 40)}`);
    const received = [];
    const timer = setTimeout(() => resolve(false), 5000);
    const onBurst = (data) => {
        received.push(data.toString('utf8'));
        if (received.length === expected.length) {
            clearTimeout(timer);
            client.off('message', onBurst);
            resolve(JSON.stringify(received) === JSON.stringify(expected));
        }
    };
    client.on('message', onBurst);
    for (const ws of wss.clients) for (const message of expected) ws.send(message);
});
check('25 synchronous sends arrive intact and in order', burstOk);

// Clean close handshake
const closeCode = await new Promise((resolve) => {
    client.on('close', (code) => resolve(code));
    client.close(1000, 'bye');
});
check('clean close (1000)', closeCode === 1000, `code=${closeCode}`);

await new Promise((r) => setTimeout(r, 100));
check('clients set drained after close', wss.clients.size === 0, `size=${wss.clients.size}`);

wss.close();
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
