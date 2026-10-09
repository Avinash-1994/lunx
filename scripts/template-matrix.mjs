/**
 * Every `lunx create` template, the way a user gets it: the packed package
 * is installed, its `lunx create` scaffolds the project, which installs its
 * dependencies from npm (lunx-dev from the tarball), builds, runs the dev
 * server and the preview server, and a browser checks each one renders the
 * app (and that its counter works).
 *
 * Run: node scripts/template-matrix.mjs [--only=react,vue] [--tarball=lunx-dev-x.tgz] [--keep]
 *      CHROMIUM_PATH=/path/to/chromium for a system browser.
 * Writes reports/TEMPLATE_MATRIX.json.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = flag('only')?.split(',');
const keep = process.argv.includes('--keep');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-templates-'));

/** id, and the variants worth a separate install. */
const VARIANTS = [
    ['vanilla'], ['vanilla', '--no-ts'], ['vanilla', '--tailwind'],
    ['react'], ['react', '--no-ts'], ['react', '--tailwind'],
    ['preact'], ['preact', '--no-ts'],
    ['vue'], ['vue', '--no-ts', '--tailwind'],
    ['svelte'], ['svelte', '--no-ts'], ['svelte', '--tailwind'],
    ['solid'], ['solid', '--no-ts'],
    ['lit'], ['lit', '--no-ts'],
    ['alpine'], ['alpine', '--no-ts'],
    ['angular'], ['qwik'],
    ['next'], ['nuxt'], ['sveltekit'], ['astro'], ['react-router'], ['tanstack-start'], ['solidstart'], ['qwik-city'],
    ['vitepress'], ['waku'], ['analog'], ['remix'], ['docusaurus'], ['marko-run'],
    ['library'], ['library', '--no-ts'], ['edge'], ['edge', '--no-ts'],
];
/** No preview server: libraries and edge functions are imported, not served. */
const NOT_SERVED = new Set(['library', 'edge']);
/** Starters whose generated TypeScript must type-check before anything runs. */
const TYPECHECK = new Set(['vanilla', 'react', 'preact', 'vue', 'svelte', 'solid', 'lit', 'alpine', 'angular', 'qwik', 'library', 'edge']);
/** Starters whose page has the counter button. */
const COUNTER = new Set(['vanilla', 'react', 'preact', 'vue', 'svelte', 'solid', 'lit', 'alpine', 'angular', 'qwik', 'sveltekit']);

function log(...args) {
    console.log(...args);
}

function run(cmd, args, cwd, timeoutMs, env = {}) {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return { code: res.status ?? (res.signal ? 1 : 0), output: `${res.stdout ?? ''}${res.stderr ?? ''}`, timedOut: res.error?.code === 'ETIMEDOUT' };
}

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** A long-running server (dev / preview) in its own process group, so the whole tree stops. */
function serve(cwd, script, port) {
    const child = spawn('npm', ['run', script, '--', '--port', String(port)], {
        cwd,
        detached: true,
        env: { ...process.env, BROWSER: 'none', NO_COLOR: '1', NEXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    return {
        get output() {
            return output;
        },
        async stop() {
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch {}
            await new Promise((r) => setTimeout(r, 1500));
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {}
        },
    };
}

async function waitForHttp(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (res.status < 500) return { status: res.status, body: await res.text() };
            last = `HTTP ${res.status}`;
        } catch (err) {
            last = err.message;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`no response from ${url}: ${last}`);
}

/** Open the page, wait for the app's heading, click the counter. */
async function checkPage(browser, url, name, counter) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
        if (msg.type() === 'error' && !/favicon|Failed to load resource.*404/i.test(msg.text())) errors.push(msg.text());
    });
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        // Text in the page and in open shadow roots (Lit renders into one).
        const deepText = () => {
            const walk = (root) => [...root.querySelectorAll('*')].map((el) => (el.shadowRoot ? walk(el.shadowRoot) : '')).join(' ') + ' ' + (root.body ?? root).textContent;
            return walk(document);
        };
        await page.waitForFunction(`(${deepText})().includes(${JSON.stringify(name)})`, null, { timeout: 60_000 });
        if (counter) {
            // Clicked until it counts: a server-rendered page ignores clicks until it has hydrated.
            const button = page.locator('button', { hasText: 'count is' }).first();
            const deadline = Date.now() + 30_000;
            for (;;) {
                await button.click({ timeout: 15_000 });
                const counted = await page
                    .waitForFunction(`/count is [1-9]/.test((${deepText})())`, null, { timeout: 1_500 })
                    .then(() => true, () => false);
                if (counted) break;
                if (Date.now() > deadline) throw new Error('the counter did not respond to clicks');
            }
        }
        if (errors.length) throw new Error(`console errors: ${errors.slice(0, 3).join(' | ')}`);
    } finally {
        await page.close();
    }
}

// ── The package, as published ────────────────────────────────────────────────

let tarball = flag('tarball') && path.resolve(flag('tarball'));
if (!tarball) {
    log('packing lunx-dev…');
    const packed = run('npm', ['pack', '--pack-destination', WORK, '--silent'], REPO, 300_000);
    if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.output}`);
    tarball = path.join(WORK, packed.output.trim().split('\n').pop());
}
const tools = path.join(WORK, 'tools');
fs.mkdirSync(tools);
fs.writeFileSync(path.join(tools, 'package.json'), '{"private":true}');
log('installing the tarball…');
const installTools = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], tools, 600_000);
if (installTools.code !== 0) throw new Error(`installing ${tarball} failed:\n${installTools.output}`);
const LUNX = path.join(tools, 'node_modules', 'lunx-dev', 'dist', 'cli.js');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const results = [];

for (const [id, ...flags] of VARIANTS) {
    if (only && !only.includes(id)) continue;
    const label = [id, ...flags].join(' ');
    const name = `app-${id}${flags.map((f) => f.replace(/^--/, '-')).join('')}`;
    const dir = path.join(WORK, name);
    const result = { template: label, create: 'fail', install: 'skip', typecheck: 'skip', build: 'skip', dev: 'skip', preview: 'skip' };
    results.push(result);
    const started = Date.now();
    try {
        const created = run(process.execPath, [LUNX, 'create', name, '--template', id, ...flags], WORK, 60_000, { npm_config_user_agent: 'npm' });
        if (created.code !== 0) throw Object.assign(new Error(created.output.trim().split('\n').slice(-3).join(' ')), { step: 'create' });
        result.create = 'pass';

        const pkgFile = path.join(dir, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (!pkg.devDependencies?.['lunx-dev']) throw Object.assign(new Error('no lunx-dev devDependency'), { step: 'create' });
        pkg.devDependencies['lunx-dev'] = `file:${tarball}`;
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

        const installed = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir, 900_000);
        if (installed.code !== 0) throw Object.assign(new Error(installed.output.trim().split('\n').slice(-6).join(' ')), { step: 'install' });
        result.install = 'pass';

        // TypeScript starters type-check as generated (meta-frameworks generate their own types first).
        if (fs.existsSync(path.join(dir, 'tsconfig.json')) && fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && TYPECHECK.has(id)) {
            const checked = run(process.execPath, [path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', '.'], dir, 300_000);
            if (checked.code !== 0) throw Object.assign(new Error(checked.output.trim().split('\n').slice(0, 8).join(' ')), { step: 'typecheck' });
            result.typecheck = 'pass';
        }

        const built = run('npm', ['run', 'build'], dir, 600_000, { NODE_ENV: 'production' });
        if (built.code !== 0) throw Object.assign(new Error(built.output.trim().split('\n').slice(-8).join(' ')), { step: 'build' });
        if (id === 'library') {
            const mod = await import(pathToFileURL(path.join(dir, 'dist', 'index.js')).href);
            if (mod.greet('lunx') !== 'Hello, lunx!') throw Object.assign(new Error('dist/index.js greet() is wrong'), { step: 'build' });
            if (!flags.includes('--no-ts') && !fs.existsSync(path.join(dir, 'dist', 'index.d.ts'))) throw Object.assign(new Error('no dist/index.d.ts'), { step: 'build' });
        } else if (id === 'edge') {
            const out = fs.readdirSync(path.join(dir, 'dist')).find((f) => /^index\.m?js$/.test(f));
            if (!out) throw Object.assign(new Error(`no dist/index.js (dist: ${fs.readdirSync(path.join(dir, 'dist')).join(', ')})`), { step: 'build' });
            const handler = (await import(pathToFileURL(path.join(dir, 'dist', out)).href)).default;
            const body = await (await handler.fetch(new Request('https://example.com/hello'))).json();
            if (body.app !== name || body.pathname !== '/hello') throw Object.assign(new Error(`fetch() answered ${JSON.stringify(body)}`), { step: 'build' });
        }
        result.build = 'pass';

        if (!NOT_SERVED.has(id)) {
            // Preview first: a framework's dev server can overwrite its build (`next dev` rewrites .next).
            for (const script of ['preview', 'dev']) {
                const port = await freePort();
                const server = serve(dir, script, port);
                try {
                    await waitForHttp(`http://127.0.0.1:${port}/`, 120_000).catch(async () => waitForHttp(`http://localhost:${port}/`, 5_000));
                    const host = await fetch(`http://127.0.0.1:${port}/`).then(() => '127.0.0.1', () => 'localhost');
                    await checkPage(browser, `http://${host}:${port}/`, name, COUNTER.has(id));
                    result[script] = 'pass';
                } catch (err) {
                    result[script] = 'fail';
                    result[`${script}Error`] = `${err.message}\n${server.output.trim().split('\n').slice(-6).join('\n')}`;
                } finally {
                    await server.stop();
                }
            }
        }
    } catch (err) {
        result[err.step ?? 'create'] = 'fail';
        result.error = err.message;
    }
    result.seconds = Math.round((Date.now() - started) / 1000);
    const failed = Object.entries(result).filter(([k, v]) => v === 'fail').map(([k]) => k);
    log(`${failed.length ? '✗' : '✓'} ${label.padEnd(28)} ${['create', 'install', 'typecheck', 'build', 'dev', 'preview'].map((k) => `${k}:${result[k]}`).join(' ')} (${result.seconds}s)`);
    for (const key of ['error', 'devError', 'previewError']) if (result[key]) log(`    ${key}: ${result[key].split('\n').join('\n    ')}`);
    if (!keep) fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
}

await browser.close();
const failed = results.filter((r) => Object.values(r).includes('fail'));
fs.writeFileSync(path.join(REPO, 'reports', 'TEMPLATE_MATRIX.json'), JSON.stringify({ tarball: path.basename(tarball), node: process.version, results }, null, 2) + '\n');
log(`\n${results.length - failed.length}/${results.length} templates passed${keep ? ` (kept in ${WORK})` : ''}`);
if (!keep) fs.rmSync(WORK, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
