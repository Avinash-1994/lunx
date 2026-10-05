#!/usr/bin/env node
/**
 * Module federation end to end, in Chromium: a React remote exposing a
 * component and a host consuming it, in every pairing of `lunx build` and
 * `lunx dev`, plus a hot update of the remote inside the host page.
 *
 *   node scripts/federation-e2e.mjs        (run `npm run build` first)
 *
 * Checks: the remote renders in the host, hooks work (one React instance via
 * the share scope), the remote's CSS applies, static and lazy remote imports
 * resolve, and (dev + dev) an edit to the remote fast-refreshes in place.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'dist/cli.js');
if (!fs.existsSync(cli)) {
    console.error('dist/cli.js missing: run `npm run build` first');
    process.exit(1);
}
const { chromium } = await import(path.join(repo, 'node_modules/playwright/index.mjs'));

const HOST_PORT = 4373;
const REMOTE_PORT = 4374;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-mf-e2e-'));
const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
};

function app(name, files, federation) {
    const root = path.join(dir, name);
    write(path.join(root, 'package.json'), JSON.stringify({ name, type: 'module', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }));
    write(path.join(root, 'lunx.config.json'), JSON.stringify({ federation }));
    for (const [f, c] of Object.entries(files)) write(path.join(root, f), c);
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    return root;
}

const shared = { react: { singleton: true }, 'react-dom': { singleton: true } };
const remote = app('remote', {
    'index.html': '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/standalone.tsx"></script></body></html>',
    'src/standalone.tsx': "import { createRoot } from 'react-dom/client';\nimport Button from './Button';\ncreateRoot(document.getElementById('root')!).render(<Button label=\"standalone\" />);\n",
    'src/Button.tsx': "import { useState } from 'react';\nimport './button.css';\nexport default function Button({ label }: { label: string }) {\n  const [n, setN] = useState(0);\n  return <button className=\"mf-btn\" onClick={() => setN(n + 1)}>{label}: {n}</button>;\n}\n",
    'src/button.css': '.mf-btn { color: rgb(255, 0, 0); }\n',
    'src/utils.ts': 'export const add = (a: number, b: number) => a + b;\n',
}, { name: 'remote', exposes: { './Button': './src/Button.tsx', './utils': './src/utils.ts' }, shared });
const host = app('host', {
    'index.html': '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    'src/main.tsx': "import { Suspense, lazy } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport { add } from 'remote/utils';\nconst Button = lazy(() => import('remote/Button'));\n(window as any).__sum = add(2, 3);\ncreateRoot(document.getElementById('root')!).render(<Suspense fallback={<p>loading</p>}><Button label=\"clicks\" /></Suspense>);\n",
}, { name: 'host', remotes: { remote: `remote@http://localhost:${REMOTE_PORT}/remoteEntry.js` }, shared });

const children = new Set();
function run(args, cwd, waitFor) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        let out = '';
        const onData = (d) => {
            out += d;
            if (waitFor && waitFor.test(out)) resolve(child);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => {
            children.delete(child);
            if (!waitFor) code === 0 ? resolve(child) : reject(new Error(`lunx ${args.join(' ')} failed:\n${out}`));
            else reject(new Error(`lunx ${args.join(' ')} exited:\n${out}`));
        });
    });
}

function serveStatic(root, port) {
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
    const server = http.createServer((req, res) => {
        let f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
        if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
        res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'access-control-allow-origin': '*' });
        fs.createReadStream(f).pipe(res);
    });
    return new Promise((resolve) => server.listen(port, () => resolve({ kill: () => server.close() })));
}

async function start(root, mode, port) {
    if (mode === 'build') {
        await run(['build'], root);
        return serveStatic(path.join(root, 'dist'), port);
    }
    return run(['dev', '--port', String(port)], root, /localhost:\d+/);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined), args: ['--no-proxy-server'] });
const results = [];

async function check(hostMode, remoteMode, hmr) {
    const servers = [await start(remote, remoteMode, REMOTE_PORT), await start(host, hostMode, HOST_PORT)];
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/WebSocket|favicon/.test(m.text()) && errors.push(m.text()));
    const name = `host ${hostMode} + remote ${remoteMode}`;
    let ok = false;
    let detail = '';
    try {
        await page.goto(`http://localhost:${HOST_PORT}/`);
        await page.waitForSelector('.mf-btn', { timeout: 15000 });
        await page.click('.mf-btn');
        const state = await page.evaluate(() => ({
            text: document.querySelector('.mf-btn')?.textContent,
            color: getComputedStyle(document.querySelector('.mf-btn')).color,
            sum: window.__sum,
        }));
        ok = state.text === 'clicks: 1' && state.color === 'rgb(255, 0, 0)' && state.sum === 5;
        detail = JSON.stringify(state);
        if (ok && hmr) {
            const file = path.join(remote, 'src/Button.tsx');
            const original = fs.readFileSync(file, 'utf8');
            await page.evaluate(() => (window.__marker = 1));
            fs.writeFileSync(file, original.replace('{label}: {n}', '{label} v2: {n}'));
            await page.waitForFunction(() => document.querySelector('.mf-btn')?.textContent === 'clicks v2: 1', null, { timeout: 10000 }).catch(() => {});
            const after = await page.evaluate(() => ({ text: document.querySelector('.mf-btn')?.textContent, samePage: window.__marker === 1 }));
            fs.writeFileSync(file, original);
            ok = after.text === 'clicks v2: 1' && after.samePage;
            detail += ` hmr=${JSON.stringify(after)}`;
        }
    } catch (err) {
        detail = err.message.split('\n')[0];
    }
    if (errors.length) {
        ok = false;
        detail += ` errors=${JSON.stringify(errors)}`;
    }
    await page.close();
    for (const s of servers) s.kill();
    await new Promise((r) => setTimeout(r, 300));
    results.push({ name, ok });
    console.log(`${ok ? '✓' : '✗'} ${name}${hmr ? ' (hot update)' : ''}  ${detail}`);
}

try {
    await check('build', 'build');
    await check('dev', 'build');
    await check('build', 'dev');
    await check('dev', 'dev', true);
} finally {
    await browser.close();
    for (const c of children) c.kill();
    fs.rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
