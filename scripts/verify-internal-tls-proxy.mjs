/**
 * Proves the hand-rolled X.509 generator produces certificates Node's TLS
 * stack actually accepts, and that the zero-dependency proxy forwards HTTP
 * and WebSocket traffic correctly.
 * Run with: npx tsx scripts/verify-internal-tls-proxy.mjs
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import WsClient from 'ws';
import { generate, generateForHosts } from '../src/lib/self-signed.ts';
import { createProxyServer } from '../src/lib/proxy.ts';
import { WebSocketServer } from '../src/lib/ws.ts';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

// ── Self-signed certificates ────────────────────────────────────────────────

const pems = generate([{ name: 'commonName', value: 'localhost' }], { days: 30 });
check('returns private/public/cert PEMs', Boolean(pems.private && pems.public && pems.cert));
check('cert is PEM-wrapped', pems.cert.startsWith('-----BEGIN CERTIFICATE-----'));

let cert;
try {
    cert = new X509Certificate(pems.cert);
    check('node can parse the certificate', true);
} catch (e) {
    check('node can parse the certificate', false, e.message);
    process.exit(1);
}

check('subject has the common name', cert.subject.includes('localhost'), cert.subject);
check('self-signed: issuer equals subject', cert.issuer === cert.subject);
check('subjectAltName covers localhost', (cert.subjectAltName ?? '').includes('localhost'), cert.subjectAltName);
check('subjectAltName covers 127.0.0.1', (cert.subjectAltName ?? '').includes('127.0.0.1'), cert.subjectAltName);
check('is a CA=false leaf', cert.ca === false);
check('signature verifies against its own key', cert.verify(cert.publicKey) === true);
check('validity is ~30 days', (() => {
    const span = (new Date(cert.validTo) - new Date(cert.validFrom)) / (24 * 60 * 60 * 1000);
    return span > 29.9 && span < 30.2;
})(), `${((new Date(cert.validTo) - new Date(cert.validFrom)) / 86400000).toFixed(2)}d`);
check('key pair matches the certificate', cert.checkPrivateKey((await import('node:crypto')).createPrivateKey(pems.private)));

// The real test: serve HTTPS with it and complete a handshake.
const multi = generateForHosts(['localhost', '127.0.0.1', 'dev.local'], 7);
const tlsServer = https.createServer({ key: multi.private, cert: multi.cert }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('secure hello');
});
await new Promise((r) => tlsServer.listen(0, '127.0.0.1', r));
const tlsPort = tlsServer.address().port;

const body = await new Promise((resolve, reject) => {
    const req = https.request(
        { host: '127.0.0.1', port: tlsPort, path: '/', rejectUnauthorized: false, servername: 'localhost' },
        (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve(data));
        },
    );
    req.on('error', reject);
    req.end();
});
check('TLS handshake succeeds with our cert', body === 'secure hello', body);

// Hostname verification against the SAN list, which is what a browser does.
const sanOk = await new Promise((resolve) => {
    const socket = tls.connect(
        { host: '127.0.0.1', port: tlsPort, servername: 'dev.local', rejectUnauthorized: false },
        () => {
            const peer = socket.getPeerCertificate();
            const err = tls.checkServerIdentity('dev.local', peer);
            socket.end();
            resolve(err === undefined);
        },
    );
    socket.on('error', () => resolve(false));
});
check('hostname check passes for an altName host', sanOk);

const sanRejects = await new Promise((resolve) => {
    const socket = tls.connect(
        { host: '127.0.0.1', port: tlsPort, servername: 'localhost', rejectUnauthorized: false },
        () => {
            const peer = socket.getPeerCertificate();
            const err = tls.checkServerIdentity('not-in-the-cert.example', peer);
            socket.end();
            resolve(err !== undefined);
        },
    );
    socket.on('error', () => resolve(false));
});
check('hostname check rejects a host not in the cert', sanRejects);

tlsServer.close();

// ── Proxy ───────────────────────────────────────────────────────────────────

// Upstream: echoes method, path, a header, and the body; also serves WS.
const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        res.writeHead(req.url === '/teapot' ? 418 : 200, { 'content-type': 'application/json', 'x-from': 'upstream' });
        res.end(
            JSON.stringify({
                method: req.method,
                url: req.url,
                body,
                host: req.headers.host,
                xff: req.headers['x-forwarded-for'] ?? null,
            }),
        );
    });
});
const upstreamWss = new WebSocketServer({ server: upstream });
upstreamWss.on('connection', (ws) => {
    ws.on('message', (data) => ws.send(`upstream:${data.toString('utf8')}`));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;
const target = `http://127.0.0.1:${upstreamPort}`;

const proxy = createProxyServer({ target, ws: true, changeOrigin: true });
const edge = http.createServer((req, res) => proxy.web(req, res));
edge.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head));
await new Promise((r) => edge.listen(0, '127.0.0.1', r));
const edgePort = edge.address().port;

async function through(path, init = {}) {
    const res = await fetch(`http://127.0.0.1:${edgePort}${path}`, init);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
}

{
    const { status, text, headers } = await through('/api/users');
    const json = JSON.parse(text);
    check('proxy forwards GET with path', status === 200 && json.url === '/api/users', `${status} ${json.url}`);
    check('proxy relays upstream headers', headers.get('x-from') === 'upstream');
    check('changeOrigin rewrites Host', json.host === `127.0.0.1:${upstreamPort}`, json.host);
    check('adds x-forwarded-for', typeof json.xff === 'string' && json.xff.length > 0, String(json.xff));
}

{
    const { text } = await through('/submit', { method: 'POST', body: 'hello=world' });
    const json = JSON.parse(text);
    check('proxy forwards POST body', json.method === 'POST' && json.body === 'hello=world', JSON.stringify(json));
}

{
    const { status } = await through('/teapot');
    check('proxy preserves status codes', status === 418, String(status));
}

{
    // Large body: proves streaming rather than truncation.
    const big = 'x'.repeat(500_000);
    const { text } = await through('/big', { method: 'POST', body: big });
    const json = JSON.parse(text);
    check('proxy streams a 500KB body', json.body.length === big.length, `${json.body.length}`);
}

{
    const rewriting = createProxyServer({ target, pathRewrite: { '^/api': '' } });
    const server = http.createServer((req, res) => rewriting.web(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/users`);
    const json = await res.json();
    check('pathRewrite strips the prefix', json.url === '/users', json.url);
    server.close();
}

{
    // WebSocket upgrade through the proxy.
    const client = new WsClient(`ws://127.0.0.1:${edgePort}/hmr`);
    const opened = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        client.on('open', () => {
            clearTimeout(timer);
            resolve(true);
        });
        client.on('error', () => {
            clearTimeout(timer);
            resolve(false);
        });
    });
    check('proxy completes the WebSocket upgrade', opened);

    if (opened) {
        const echoed = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), 5000);
            client.once('message', (d) => {
                clearTimeout(timer);
                resolve(d.toString('utf8'));
            });
            client.send('ping through proxy');
        });
        check('proxy relays WebSocket frames', echoed === 'upstream:ping through proxy', String(echoed));
        client.close();
    }
}

{
    // A dead target must surface as 502, not a hang.
    const broken = createProxyServer({ target: 'http://127.0.0.1:1' });
    const server = http.createServer((req, res) => broken.web(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    check('unreachable target yields 502', res.status === 502, String(res.status));
    server.close();
}

{
    // An `error` listener should receive the failure instead of the default 502.
    let seen = null;
    const listening = createProxyServer({ target: 'http://127.0.0.1:1' });
    listening.on('error', (err, _req, res) => {
        seen = err.message;
        res.writeHead(503);
        res.end('custom');
    });
    const server = http.createServer((req, res) => listening.web(req, res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    check('error listener is used when present', res.status === 503 && typeof seen === 'string', `${res.status} ${seen}`);
    server.close();
}

edge.close();
upstreamWss.close();
upstream.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
