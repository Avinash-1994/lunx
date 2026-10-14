#!/usr/bin/env node
/**
 * Module federation across tools, in Chromium: lunx with webpack 5 and Rspack,
 * as host and as remote, all production builds. Each remote exposes a React
 * component with state; each host renders it with React shared as a singleton.
 *
 * Checks per pairing: the remote renders inside the host, its state updates
 * on click (one React: two copies would throw "Invalid hook call"), and the
 * page logs no errors.
 *
 *   node scripts/federation-interop.mjs [--only=lunx-host+webpack-remote] [--keep]
 *
 * Writes reports/FEDERATION_INTEROP.json. scripts/federation-e2e.mjs covers
 * lunx with lunx, in build and dev.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = flag('only')?.split(',');
const keep = process.argv.includes('--keep');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-mf-interop-'));
const log = (...a) => console.log(...a);

function run(cmd, args, cwd, timeout = 300_000, env = {}) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, env: { ...process.env, NO_COLOR: '1', ...env }, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

const freePort = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
    });
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
function serve(dist, port) {
    const server = http.createServer((req, res) => {
        let file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (file.endsWith(path.sep)) file = path.join(file, 'index.html');
        const headers = { 'Access-Control-Allow-Origin': '*' };
        if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404, headers);
            res.end();
            return;
        }
        res.writeHead(200, { ...headers, 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        res.end(fs.readFileSync(file));
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function write(dir, files) {
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
}

// ── Apps ─────────────────────────────────────────────────────────────────────

const WIDGET_JS = (id) => `import React, { useState } from 'react';
export default function Widget() {
  const [n, setN] = useState(0);
  return React.createElement('button', { id: '${id}', className: 'remote', onClick: () => setN(n + 1) }, '${id} ' + n);
}
`;
/** A host rendering every remote's Widget, each lazily. */
const HOST_JS = (remotes) => `import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
${remotes.map((r, i) => `const W${i} = lazy(() => import('${r.name}/Widget'));`).join('\n')}
createRoot(document.getElementById('root')).render(
  React.createElement('div', { id: 'host' }, 'host ', React.createElement(Suspense, { fallback: 'loading' }, ${remotes.map((_, i) => `React.createElement(W${i})`).join(', ')})),
);
`;
const SHARED = { react: { singleton: true, requiredVersion: '^19.0.0' }, 'react-dom': { singleton: true, requiredVersion: '^19.0.0' } };

/** A lunx app: a remote exposing ./Widget, or a host using `remote`. */
function lunxApp(dir, role, remotes = []) {
    write(dir, {
        'package.json': JSON.stringify({ name: `lunx-${role}`, private: true, type: 'module', dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' } }),
        'index.html': '<!DOCTYPE html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>',
        'src/Widget.js': WIDGET_JS('lxRemote'),
        'src/main.js': role === 'remote' ? "document.getElementById('root').textContent = 'lunx remote';\n" : HOST_JS(remotes),
        'lunx.config.json': JSON.stringify({
            federation: role === 'remote'
                ? { name: 'lxRemote', filename: 'remoteEntry.js', exposes: { './Widget': './src/Widget.js' }, shared: SHARED }
                : { name: 'lxHost', remotes: Object.fromEntries(remotes.map((r) => [r.name, r.spec])), shared: SHARED },
        }),
    });
    fs.symlinkSync(path.join(WORK, 'shared', 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const built = run(process.execPath, ['node_modules/lunx-dev/dist/cli.js', 'build'], dir, 300_000, { NODE_ENV: 'production', LUNX_SKIP_SECURITY: '1', LUNX_BUILD_CACHE: '0' });
    if (built.code !== 0) throw new Error(`lunx ${role} build failed: ${built.output.trim().split('\n').slice(-8).join(' ')}`);
    return path.join(dir, 'dist');
}

/** A webpack or Rspack app, built through its Node API (no loaders: the code is plain JS). */
function bundlerApp(tool, dir, role, port, remotes = []) {
    const name = `${tool === 'webpack' ? 'wp' : 'rs'}${role === 'remote' ? 'Remote' : 'Host'}`;
    write(dir, {
        'src/Widget.js': WIDGET_JS(name),
        'src/bootstrap.js': role === 'remote' ? "document.getElementById('root').textContent = 'remote';\n" : HOST_JS(remotes),
        // The async boundary module federation needs before shared modules are used.
        'src/index.js': "import('./bootstrap.js');\n",
    });
    fs.symlinkSync(path.join(WORK, 'shared', 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    // Per remote: a script container (\`name@url\`), or lunx's ES module one, loaded with import().
    const federation = role === 'remote'
        ? { name, filename: 'remoteEntry.js', exposes: { './Widget': './src/Widget.js' }, shared: SHARED }
        : {
            name,
            // All ES module remotes: remoteType 'import'. Mixed: webpack's per-remote type prefix ('import <url>').
            ...(remotes.every((r) => r.esm) ? { remoteType: 'import' } : {}),
            remotes: Object.fromEntries(remotes.map((r) => [r.name, r.esm ? (remotes.every((x) => x.esm) ? r.url : `import ${r.url}`) : r.spec])),
            shared: SHARED,
        };
    const script = `
const { createRequire } = require('module');
const req = createRequire(${JSON.stringify(path.join(dir, 'package.json'))});
const tool = req(${JSON.stringify(tool === 'webpack' ? 'webpack' : '@rspack/core')});
const MF = tool.container.ModuleFederationPlugin;
const compiler = tool({
  mode: 'production',
  // import() for an ES module remote (lunx's remoteEntry.js): webpack's default target assumes ES5.
  target: ['web', 'es2020'],
  context: ${JSON.stringify(dir)},
  entry: './src/index.js',
  output: { path: ${JSON.stringify(path.join(dir, 'dist'))}, publicPath: 'http://127.0.0.1:${port}/', uniqueName: ${JSON.stringify(name)}, clean: true },
  plugins: [new MF(${JSON.stringify(federation)})],
});
compiler.run((err, stats) => {
  if (err || stats.hasErrors()) { console.error(err || stats.toString({ all: false, errors: true })); process.exit(1); }
  compiler.close(() => {});
});
`;
    fs.writeFileSync(path.join(dir, 'build.cjs'), script);
    const built = run(process.execPath, ['build.cjs'], dir, 300_000, { NODE_ENV: 'production' });
    if (built.code !== 0) throw new Error(`${tool} ${role} build failed: ${built.output.trim().split('\n').slice(-12).join(' ')}`);
    fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<!DOCTYPE html><html><body><div id="root"></div><script src="main.js"></script></body></html>');
    return path.join(dir, 'dist');
}

const REMOTE_NAMES = { lunx: 'lxRemote', webpack: 'wpRemote', rspack: 'rsRemote' };
const PAIRS = [
    // lunx's runtime takes a script container (`name@url`, a global), as webpack and Rspack write by default.
    { name: 'lunx-host+webpack-remote', host: 'lunx', remotes: ['webpack'] },
    { name: 'lunx-host+rspack-remote', host: 'lunx', remotes: ['rspack'] },
    // lunx's remoteEntry.js is an ES module: webpack / Rspack hosts load it with import().
    { name: 'webpack-host+lunx-remote', host: 'webpack', remotes: ['lunx'] },
    { name: 'rspack-host+lunx-remote', host: 'rspack', remotes: ['lunx'] },
    // A shell with remotes from every tool at once, one React for all of them.
    { name: 'lunx-host+lunx,webpack,rspack-remotes', host: 'lunx', remotes: ['lunx', 'webpack', 'rspack'] },
    { name: 'webpack-host+lunx,rspack-remotes', host: 'webpack', remotes: ['lunx', 'rspack'] },
];

// ── Run ──────────────────────────────────────────────────────────────────────

const pairs = PAIRS.filter((p) => !only || only.includes(p.name));
let tarball = flag('tarball') && path.resolve(flag('tarball'));
if (!tarball) {
    log('packing lunx-dev…');
    const packed = run('npm', ['pack', '--pack-destination', WORK, '--silent'], REPO);
    if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.output}`);
    tarball = path.join(WORK, packed.output.trim().split('\n').pop());
}
const shared = path.join(WORK, 'shared');
write(shared, { 'package.json': JSON.stringify({ name: 'mf-interop', private: true }) });
const packages = ['react@^19.0.0', 'react-dom@^19.0.0', 'webpack', '@rspack/core', '@module-federation/runtime-tools'];
log('installing lunx-dev, react, webpack and Rspack…');
const install = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--legacy-peer-deps', tarball, ...packages], shared, 900_000);
if (install.code !== 0) throw new Error(`npm install failed:\n${install.output}`);
const version = (p) => JSON.parse(fs.readFileSync(path.join(shared, 'node_modules', p, 'package.json'), 'utf8')).version;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const results = [];
for (const pair of pairs) {
    const result = { pair: pair.name, status: 'fail', errors: [] };
    const servers = [];
    try {
        const hostPort = await freePort();
        const remotes = [];
        for (const tool of pair.remotes) {
            const port = await freePort();
            const dir = path.join(WORK, pair.name, `${tool}-remote`);
            const dist = tool === 'lunx' ? lunxApp(dir, 'remote') : bundlerApp(tool, dir, 'remote', port);
            servers.push(await serve(dist, port));
            const name = REMOTE_NAMES[tool];
            const url = `http://127.0.0.1:${port}/remoteEntry.js`;
            remotes.push({ name, url, spec: `${name}@${url}`, esm: tool === 'lunx' });
        }
        const hostDir = path.join(WORK, pair.name, 'host');
        const hostDist = pair.host === 'lunx' ? lunxApp(hostDir, 'host', remotes) : bundlerApp(pair.host, hostDir, 'host', hostPort, remotes);
        servers.push(await serve(hostDist, hostPort));

        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.location()?.url ?? '') && errors.push(m.text()));
        try {
            await page.goto(`http://127.0.0.1:${hostPort}/`, { waitUntil: 'load', timeout: 30_000 });
            for (const r of remotes) {
                await page.waitForFunction((id) => document.getElementById(id)?.textContent === id + ' 0', r.name, { timeout: 20_000 });
                await page.click(`#${r.name}`);
                await page.waitForFunction((id) => document.getElementById(id)?.textContent === id + ' 1', r.name, { timeout: 10_000 });
            }
            if (errors.length) throw new Error(`console: ${errors.slice(0, 2).join(' | ')}`);
            result.status = 'pass';
        } catch (e) {
            const html = await page.evaluate(() => document.body.innerHTML.slice(0, 300)).catch(() => '');
            throw new Error(`${e.message.split('\n')[0]}${errors.length ? ` | console: ${errors.slice(0, 2).join(' | ')}` : ''} | page: ${html}`);
        } finally {
            await page.close();
        }
    } catch (e) {
        result.errors.push(String(e.message).slice(0, 1500));
    } finally {
        for (const s of servers) s.close();
    }
    results.push(result);
    log(`${result.status === 'pass' ? '✓' : '✗'} ${pair.name}${result.errors.length ? `\n    ${result.errors.join('\n    ')}` : ''}`);
}
await browser.close();

fs.writeFileSync(path.join(REPO, 'reports', 'FEDERATION_INTEROP.json'), JSON.stringify({
    lunx: version('lunx-dev'), webpack: version('webpack'), rspack: version('@rspack/core'), react: version('react'), node: process.version, results,
}, null, 2) + '\n');
const passed = results.filter((r) => r.status === 'pass').length;
log(`\n${passed}/${results.length} pairings passed`);
if (!keep) fs.rmSync(WORK, { recursive: true, force: true });
else log(`kept in ${WORK}`);
process.exitCode = passed === results.length ? 0 : 1;
