/**
 * Benchmarks lunx against every build tool that can be installed from npm, on
 * one identical React + TypeScript app.
 *
 *   npx tsx scripts/bench-arena.mjs [--app <dir>] [--runs 3] [--only lunx,vite] [--scale 2000] [--hmr]
 *
 * Without --app it scaffolds the app and installs ~500 MB of toolchains, so
 * pass --app to reuse a prepared directory.
 *
 * Metrics, per tool:
 *   dev boot    spawn → GET / returns 200
 *   app code    spawn → the first <script src> in that HTML returns 200.
 *               For module servers (lunx, vite) this is one transformed
 *               module; for bundler dev servers (webpack, rspack, parcel) it
 *               is the whole bundle, because that is what they must produce
 *               before the browser can run anything. Same question either
 *               way: when can the app start executing?
 *   build       production build, cold (no cache) and warm
 *   output      JS + CSS bytes emitted
 *   hmr         (--hmr) save a change to App.tsx → Chromium shows it
 *
 * --scale N renders a tree of N generated components (plus a shared sheet) from
 * App, in a copy of the app that shares its node_modules.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LUNX_CLI = path.join(REPO, 'dist', 'cli.js');
const RUNS = Number(flag('--runs') ?? 3);
const ONLY = (flag('--only') ?? '').split(',').filter(Boolean);

function flag(name) {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
        s.on('error', reject);
    });
}

function sizeOf(dir, re) {
    let total = 0;
    const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (re.test(e.name)) total += fs.statSync(p).size;
        }
    };
    walk(dir);
    return total;
}

const PACKAGES = [
    'react', 'react-dom',
    'vite', '@vitejs/plugin-react',
    '@rspack/core', '@rspack/cli',
    'webpack', 'webpack-cli', 'webpack-dev-server', 'html-webpack-plugin',
    'swc-loader', 'css-loader', 'style-loader',
    'esbuild', 'parcel', 'rolldown', 'bun',
    '@rspack/dev-server',
    // swc 1.16.x refuses to load its native addon on some Windows setups,
    // which takes swc-loader (and therefore webpack and rspack) down with it.
    '@swc/core@1.15.24',
];

const APP_FILES = {
    'package.json': JSON.stringify({ name: 'arena', private: true, version: '0.0.0' }, null, 2),
    'index.html': [
        '<!doctype html>',
        '<html><head><meta charset="utf-8"><title>arena</title></head>',
        '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    ].join('\n'),
    'src/main.tsx': [
        "import React from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import App from './App';",
        "import './app.css';",
        "createRoot(document.getElementById('root')!).render(<App />);",
        '',
    ].join('\n'),
    'src/App.tsx': [
        "import React, { useState } from 'react';",
        'export default function App() {',
        '  const [n, setN] = useState(0);',
        '  return <div className="card"><h1 id="t">arena</h1><button onClick={() => setN(n + 1)}>count {n}</button></div>;',
        '}',
        '',
    ].join('\n'),
    'src/app.css': '.card { color: rgb(17, 34, 51); padding: 8px; }\n',
    // JS-only entry: rolldown 1.2.x removed CSS bundling, so it gets an entry
    // without the stylesheet rather than a failed build.
    'src/main.nocss.tsx': [
        "import React from 'react';",
        "import { createRoot } from 'react-dom/client';",
        "import App from './App';",
        "createRoot(document.getElementById('root')!).render(<App />);",
        '',
    ].join('\n'),
};

function scaffold() {
    const dir = path.join(os.tmpdir(), `lunx-arena-${Date.now()}`);
    for (const [rel, content] of Object.entries(APP_FILES)) {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf8');
    }
    writeConfigs(dir);
    console.log(`app: ${dir}\ninstalling toolchains (this is large)...`);
    const r = spawnSync('npm', ['install', '--silent', '--no-fund', '--no-audit', ...PACKAGES], {
        cwd: dir, encoding: 'utf8', shell: true,
    });
    if (r.status !== 0) {
        console.error(r.stderr || r.stdout);
        process.exit(1);
    }
    return dir;
}

function writeConfigs(dir) {
    const w = (rel, s) => fs.writeFileSync(path.join(dir, rel), s, 'utf8');

    w('vite.config.mjs', [
        "import react from '@vitejs/plugin-react';",
        "export default { plugins: [react()], logLevel: 'error', build: { outDir: 'out-vite' } };",
        '',
    ].join('\n'));

    const swcLoaderOptions = [
        '                        jsc: {',
        "                            parser: { syntax: 'typescript', tsx: true },",
        "                            transform: { react: { runtime: 'automatic' } },",
        '                        },',
    ].join('\n');

    w('rspack.config.js', [
        "const { HtmlRspackPlugin } = require('@rspack/core');",
        "const path = require('path');",
        'module.exports = {',
        "    mode: process.env.NODE_ENV === 'development' ? 'development' : 'production',",
        "    entry: { main: './src/main.tsx' },",
        "    output: { path: path.resolve(__dirname, 'out-rspack'), clean: true },",
        "    resolve: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },",
        '    module: { rules: [',
        '        { test: /\\.tsx?$/, use: { loader: "builtin:swc-loader", options: {',
        swcLoaderOptions,
        '        } } },',
        "        { test: /\\.css$/, type: 'css' },",
        '    ] },',
        "    plugins: [new HtmlRspackPlugin({ template: './index.html' })],",
        '    experiments: { css: true },',
        "    stats: 'errors-only',",
        "    infrastructureLogging: { level: 'error' },",
        "    devServer: { hot: true, client: { logging: 'error' } },",
        '};',
        '',
    ].join('\n'));

    w('webpack.config.js', [
        "const HtmlWebpackPlugin = require('html-webpack-plugin');",
        "const path = require('path');",
        'module.exports = {',
        "    mode: process.env.NODE_ENV === 'development' ? 'development' : 'production',",
        "    entry: { main: './src/main.tsx' },",
        "    output: { path: path.resolve(__dirname, 'out-webpack'), clean: true },",
        "    resolve: { extensions: ['.ts', '.tsx', '.js', '.jsx'] },",
        '    module: { rules: [',
        '        { test: /\\.tsx?$/, use: { loader: "swc-loader", options: {',
        swcLoaderOptions,
        '        } } },',
        "        { test: /\\.css$/, use: ['style-loader', 'css-loader'] },",
        '    ] },',
        "    plugins: [new HtmlWebpackPlugin({ template: './index.html' })],",
        "    stats: 'errors-only',",
        "    infrastructureLogging: { level: 'error' },",
        "    devServer: { hot: true, client: { logging: 'error' } },",
        '};',
        '',
    ].join('\n'));

    w('rolldown.config.mjs', [
        'export default {',
        "    input: 'src/main.nocss.tsx',",
        "    output: { dir: 'out-rolldown', format: 'esm', minify: true },",
        '    define: { "process.env.NODE_ENV": JSON.stringify("production") },',
        "    resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js'] },",
        "    transform: { jsx: 'react-jsx' },",
        '};',
        '',
    ].join('\n'));
}

const baseApp = flag('--app') ? path.resolve(flag('--app')) : scaffold();
const SCALE = Number(flag('--scale') ?? 0);
const HMR = process.argv.includes('--hmr');
const app = SCALE ? scaleApp(baseApp, SCALE) : baseApp;

/**
 * --scale N: a copy of the app (sharing its node_modules) whose App renders a
 * tree of N generated components, each with a CSS class from shared sheets.
 */
function scaleApp(src, n) {
    const dir = `${src}-scale-${n}`;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'src', 'gen'), { recursive: true });
    for (const e of fs.readdirSync(src)) {
        if (e === 'node_modules' || e.startsWith('out-') || e.startsWith('.')) continue;
        fs.cpSync(path.join(src, e), path.join(dir, e), { recursive: true });
    }
    fs.symlinkSync(path.join(src, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    for (let i = 0; i < n; i++) {
        const kids = [2 * i + 1, 2 * i + 2].filter((k) => k < n);
        fs.writeFileSync(path.join(dir, 'src', 'gen', `C${i}.tsx`), [
            ...kids.map((k) => `import C${k} from './C${k}';`),
            `export default function C${i}({ depth = 0 }: { depth?: number }) {`,
            `  const label: string = 'node ${i} ' + depth;`,
            `  return <div className="c${i % 50}">{label}${kids.map((k) => `<C${k} depth={depth + 1} />`).join('')}</div>;`,
            '}',
            '',
        ].join('\n'));
    }
    // Styles enter through main.tsx only: the JS-only rolldown entry stays CSS-free.
    fs.writeFileSync(path.join(dir, 'src', 'gen', 'all.css'), Array.from({ length: 50 }, (_, j) => `.c${j} { margin: ${j % 7}px; }`).join('\n'));
    const main = path.join(dir, 'src', 'main.tsx');
    fs.writeFileSync(main, "import './gen/all.css';\n" + fs.readFileSync(main, 'utf8'));
    const app = fs.readFileSync(path.join(dir, 'src', 'App.tsx'), 'utf8');
    fs.writeFileSync(path.join(dir, 'src', 'App.tsx'), "import C0 from './gen/C0';\n" + app.replace('</div>;', '<C0 /></div>;'));
    console.log(`scaled app: ${dir} (${n} components)`);
    return dir;
}

let browserPromise = null;
async function browser() {
    if (!browserPromise) {
        browserPromise = import(path.join(REPO, 'node_modules', 'playwright', 'index.mjs')).then(({ chromium }) =>
            chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined), args: ['--no-proxy-server'] }));
    }
    return browserPromise;
}

/** Save a change to App.tsx and time until the page shows it. */
async function hmrRun(port) {
    const file = path.join(app, 'src', 'App.tsx');
    const original = fs.readFileSync(file, 'utf8');
    const page = await (await browser()).newPage();
    try {
        await page.goto(`http://127.0.0.1:${port}/`, { timeout: 120_000 });
        await page.waitForFunction(() => document.querySelector('#t')?.textContent === 'arena', null, { timeout: 120_000 });
        await sleep(500);
        const t0 = Date.now();
        fs.writeFileSync(file, original.replace('>arena<', '>arena-hmr<'));
        await page.waitForFunction(() => document.querySelector('#t')?.textContent === 'arena-hmr', null, { timeout: 60_000, polling: 'raf' });
        return Date.now() - t0;
    } catch {
        return null;
    } finally {
        fs.writeFileSync(file, original);
        await page.close();
    }
}
const bin = (name) => path.join(app, 'node_modules', '.bin', name + (process.platform === 'win32' ? '.cmd' : ''));
const PROD = { NODE_ENV: 'production' };
const DEV = { NODE_ENV: 'development' };

const TOOLS = {
    lunx: {
        kind: 'module server',
        dev: (port) => [process.execPath, [LUNX_CLI, 'dev', '--root', app, '--port', String(port)], {}],
        build: () => [process.execPath, [LUNX_CLI, 'build', '--root', app, '--outDir', 'out-lunx'], PROD],
        out: 'out-lunx',
        caches: ['.lunx'],
    },
    vite: {
        kind: 'module server',
        dev: (port) => [bin('vite'), ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], {}],
        build: () => [bin('vite'), ['build'], PROD],
        out: 'out-vite',
        caches: ['node_modules/.vite'],
    },
    rspack: {
        kind: 'bundler',
        dev: (port) => [bin('rspack'), ['serve', '--port', String(port)], DEV],
        build: () => [bin('rspack'), ['build'], PROD],
        out: 'out-rspack',
        caches: ['node_modules/.cache'],
    },
    webpack: {
        kind: 'bundler',
        dev: (port) => [bin('webpack-dev-server'), ['--port', String(port)], DEV],
        build: () => [bin('webpack'), [], PROD],
        out: 'out-webpack',
        caches: ['node_modules/.cache'],
    },
    parcel: {
        kind: 'bundler',
        dev: (port) => [bin('parcel'), ['index.html', '--port', String(port), '--dist-dir', '.parcel-dev'], DEV],
        build: () => [bin('parcel'), ['build', 'index.html', '--dist-dir', 'out-parcel', '--no-cache'], PROD],
        out: 'out-parcel',
        caches: ['.parcel-cache', '.parcel-dev'],
    },
    esbuild: {
        kind: 'bundler',
        dev: null, // --servedir serves files; no HMR, no HTML entry graph
        build: () => [bin('esbuild'), [
            'src/main.tsx', '--bundle', '--minify', '--format=esm',
            '--outdir=out-esbuild', '--loader:.css=css',
            '--define:process.env.NODE_ENV="production"',
        ], PROD],
        out: 'out-esbuild',
        caches: [],
    },
    bun: {
        kind: 'bundler',
        dev: null, // `bun ./index.html` needs bun's own runtime, not node
        build: () => [bin('bun'), [
            'build', './src/main.tsx', '--outdir', 'out-bun', '--minify',
            '--target', 'browser', '--define', 'process.env.NODE_ENV="production"',
        ], PROD],
        out: 'out-bun',
        caches: [],
    },
    rolldown: {
        kind: 'bundler (JS only)',
        dev: null,
        build: () => [bin('rolldown'), ['-c', 'rolldown.config.mjs'], PROD],
        out: 'out-rolldown',
        caches: [],
    },
};

/** cmd.exe is needed for .cmd shims, but it mangles node's own path (it has a
 *  space in it), so pick per command rather than globally. */
const needsShell = (cmd) => cmd.endsWith('.cmd') || cmd.endsWith('.bat');

/** cmd.exe eats double quotes, which silently turned
 *  `--define:process.env.NODE_ENV="production"` into an undefined global and
 *  left React's development branches in the bundle (649 KB instead of 223 KB).
 */
const escapeArgs = (cmd, args) =>
    needsShell(cmd) ? args.map((a) => a.replace(/"/g, '\\"')) : args;

function clearCaches(tool) {
    for (const c of tool.caches) {
        // Parcel keeps an LMDB handle open briefly after exit; a locked cache
        // file is not a reason to abort the run.
        try {
            fs.rmSync(path.join(app, c), { recursive: true, force: true });
        } catch {}
    }
}

async function waitFor(port, urlPath, deadlineMs) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}${urlPath}`);
            if (res.status === 200) return await res.text();
        } catch {}
        await sleep(5);
    }
    return null;
}

async function devRun(tool) {
    const port = await freePort();
    const [cmd, args, env] = tool.dev(port);
    const t0 = Date.now();
    const child = spawn(cmd, escapeArgs(cmd, args), {
        cwd: app,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: needsShell(cmd),
        env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));

    const html = await waitFor(port, '/', 120_000);
    if (html === null) {
        child.kill('SIGKILL');
        return { error: log.slice(-600) || 'timeout' };
    }
    const bootMs = Date.now() - t0;

    // Whatever the page loads first is what the browser needs to run the app.
    const m = html.match(/<script[^>]+src=["']([^"']+)["']/i);
    let appCodeMs = null;
    if (m) {
        const src = m[1].startsWith('http') ? new URL(m[1]).pathname : m[1];
        const body = await waitFor(port, src.startsWith('/') ? src : `/${src}`, 120_000);
        if (body !== null) appCodeMs = Date.now() - t0;
    }

    const hmrMs = HMR ? await hmrRun(port) : null;
    child.kill('SIGKILL');
    await sleep(300);
    return { bootMs, appCodeMs, hmrMs };
}

function buildRun(tool) {
    fs.rmSync(path.join(app, tool.out), { recursive: true, force: true });
    const [cmd, args, env] = tool.build();
    const t0 = Date.now();
    const r = spawnSync(cmd, escapeArgs(cmd, args), {
        cwd: app,
        encoding: 'utf8',
        shell: needsShell(cmd),
        env: { ...process.env, ...env, NO_COLOR: '1' },
    });
    const ms = Date.now() - t0;
    const out = path.join(app, tool.out);
    return {
        ms,
        status: r.status,
        log: ((r.stdout || '') + (r.stderr || '')).slice(-500),
        js: sizeOf(out, /\.(js|mjs)$/),
        css: sizeOf(out, /\.css$/),
    };
}

if (!fs.existsSync(LUNX_CLI)) {
    console.error(`missing ${LUNX_CLI} — run \`npm run build\` first.`);
    process.exit(1);
}

const results = {};
for (const [name, tool] of Object.entries(TOOLS)) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    const r = { kind: tool.kind };

    if (tool.dev) {
        const boots = [];
        const codes = [];
        const hmrs = [];
        for (let i = 0; i < RUNS; i++) {
            clearCaches(tool);
            const d = await devRun(tool);
            if (d.error) {
                r.devError = d.error;
                console.log(`${name} dev FAILED: ${d.error.split('\n').slice(-3).join(' ')}`);
                break;
            }
            boots.push(d.bootMs);
            if (d.appCodeMs !== null) codes.push(d.appCodeMs);
            if (d.hmrMs !== null && d.hmrMs !== undefined) hmrs.push(d.hmrMs);
            console.log(`${name} dev ${i + 1}/${RUNS}: boot ${d.bootMs}ms, app code ${d.appCodeMs}ms${HMR ? `, hmr ${d.hmrMs ?? 'failed'}ms` : ''}`);
        }
        if (boots.length) r.devBootMs = median(boots);
        if (codes.length) r.devAppCodeMs = median(codes);
        if (hmrs.length) r.hmrMs = median(hmrs);
    } else {
        r.devBootMs = null;
    }

    clearCaches(tool);
    const cold = buildRun(tool);
    if (cold.status !== 0) {
        r.buildError = cold.log;
        console.log(`${name} build FAILED (exit ${cold.status})`);
    } else {
        const warm = [];
        for (let i = 0; i < RUNS; i++) warm.push(buildRun(tool).ms);
        r.buildColdMs = cold.ms;
        r.buildWarmMs = median(warm);
        r.jsBytes = cold.js;
        r.cssBytes = cold.css;
        console.log(`${name} build: cold ${cold.ms}ms, warm ${median(warm)}ms, js ${cold.js}B, css ${cold.css}B`);
    }
    results[name] = r;
}

const cols = [
    ['tool', (k) => k, 10],
    ['kind', (k) => results[k].kind, 20],
    ['dev boot', (k) => fmt(results[k].devBootMs, 'ms'), 10],
    ['app code', (k) => fmt(results[k].devAppCodeMs, 'ms'), 10],
    ...(HMR ? [['hmr', (k) => fmt(results[k].hmrMs, 'ms'), 9]] : []),
    ['build cold', (k) => fmt(results[k].buildColdMs, 'ms'), 11],
    ['build warm', (k) => fmt(results[k].buildWarmMs, 'ms'), 11],
    ['JS', (k) => fmt(results[k].jsBytes, 'B'), 10],
    ['CSS', (k) => fmt(results[k].cssBytes, 'B'), 8],
];
function fmt(v, unit) {
    if (v === null || v === undefined) return '-';
    return `${v}${unit}`;
}
console.log('\n' + cols.map(([h, , w]) => h.padEnd(w)).join(''));
for (const k of Object.keys(results)) {
    console.log(cols.map(([, f, w]) => String(f(k)).padEnd(w)).join(''));
}

fs.mkdirSync(path.join(REPO, 'reports'), { recursive: true });
const reportName = SCALE ? `BENCH_ARENA_SCALE_${SCALE}.json` : 'BENCH_ARENA.json';
fs.writeFileSync(path.join(REPO, 'reports', reportName), JSON.stringify({ scale: SCALE || null, runs: RUNS, results }, null, 2));
console.log(`\nreport: reports${path.sep}${reportName}`);
if (browserPromise) await (await browserPromise).close();
