/**
 * Head-to-head benchmark: lunx against vite, on one identical React + TS app.
 *
 * Measures dev cold boot, first-request transform latency, cold and warm
 * production builds, and output size, then prints a table. Each timing is the
 * median of --runs runs (default 5).
 *
 * Run: npx tsx scripts/bench-vs-vite.mjs [--runs 5] [--keep]
 *
 * lunx is benchmarked through dist/cli.js, not through tsx, so the comparison
 * is CLI against CLI rather than "interpreted TypeScript" against "shipped
 * JavaScript". Run `npm run build` first.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LUNX_CLI = path.join(REPO, 'dist', 'cli.js');
const RUNS = Number(argValue('--runs') ?? 5);
const KEEP = process.argv.includes('--keep');

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i === -1 ? undefined : process.argv[i + 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES = {
    'package.json': JSON.stringify({ name: 'lunx-bench', private: true, version: '0.0.0', type: 'module' }, null, 2),
    'index.html': [
        '<!doctype html>',
        '<html><head><meta charset="utf-8"><title>bench</title></head>',
        '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    ].join('\n'),
    'vite.config.js': "import react from '@vitejs/plugin-react';\nexport default { plugins: [react()], logLevel: 'error' };\n",
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
        '  return <div className="card"><h1 id="t">bench</h1><button onClick={() => setN(n + 1)}>count {n}</button></div>;',
        '}',
        '',
    ].join('\n'),
    'src/app.css': '.card { color: rgb(17, 34, 51); padding: 8px; }\n',
};

function scaffold() {
    const dir = path.join(os.tmpdir(), `lunx-bench-${Date.now()}`);
    for (const [rel, content] of Object.entries(FILES)) {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf8');
    }
    console.log(`app: ${dir}\ninstalling react + vite...`);
    const install = spawnSync(
        'npm',
        ['install', '--silent', '--no-fund', '--no-audit', 'react', 'react-dom', 'vite', '@vitejs/plugin-react'],
        { cwd: dir, encoding: 'utf8', shell: true }
    );
    if (install.status !== 0) {
        console.error(install.stderr || install.stdout);
        process.exit(1);
    }
    return dir;
}

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

const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

function sizeOf(dir, filter) {
    let total = 0;
    const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (filter(e.name)) total += fs.statSync(p).size;
        }
    };
    walk(dir);
    return total;
}

async function waitForServer(port, deadlineMs) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            if (res.status === 200) {
                await res.text();
                return true;
            }
        } catch {}
        await sleep(5);
    }
    return false;
}

function clearCaches(app) {
    for (const d of ['.lunx', 'node_modules/.vite', 'node_modules/.cache']) {
        fs.rmSync(path.join(app, d), { recursive: true, force: true });
    }
}

async function devRun(app, argsFor) {
    const port = await freePort();
    const t0 = Date.now();
    const child = spawn(process.execPath, argsFor(port), {
        cwd: app,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));

    if (!(await waitForServer(port, 90_000))) {
        child.kill('SIGKILL');
        return { error: log.slice(-800) };
    }
    const bootMs = Date.now() - t0;

    // First, uncached request for the entry module: the transform itself.
    const te = Date.now();
    let entryMs = null;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/src/main.tsx`);
        await res.text();
        if (res.status === 200) entryMs = Date.now() - te;
    } catch {}

    child.kill('SIGKILL');
    await sleep(250);
    return { bootMs, entryMs };
}

function buildRun(app, args, outDir) {
    fs.rmSync(path.join(app, outDir), { recursive: true, force: true });
    const t0 = Date.now();
    const r = spawnSync(process.execPath, args, {
        cwd: app,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
    });
    const ms = Date.now() - t0;
    if (r.status !== 0) console.log((r.stdout || '') + (r.stderr || ''));
    const out = path.join(app, outDir);
    return {
        ms,
        status: r.status,
        js: sizeOf(out, (n) => /\.(js|mjs)$/.test(n)),
        br: sizeOf(out, (n) => n.endsWith('.br')),
    };
}

const app = scaffold();
const viteCli = path.join(app, 'node_modules', 'vite', 'bin', 'vite.js');

if (!fs.existsSync(LUNX_CLI)) {
    console.error(`missing ${LUNX_CLI} — run \`npm run build\` first.`);
    process.exit(1);
}

const tools = {
    lunx: {
        dev: (port) => [LUNX_CLI, 'dev', '--root', app, '--port', String(port)],
        build: [LUNX_CLI, 'build', '--root', app, '--outDir', 'dist-lunx'],
        outDir: 'dist-lunx',
    },
    vite: {
        dev: (port) => [viteCli, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
        build: [viteCli, 'build', '--outDir', 'dist-vite'],
        outDir: 'dist-vite',
    },
};

const out = {};
for (const [name, t] of Object.entries(tools)) {
    const boots = [];
    const entries = [];
    for (let i = 0; i < RUNS; i++) {
        clearCaches(app);
        const r = await devRun(app, t.dev);
        if (r.error) {
            console.log(`${name} dev FAILED:\n${r.error}`);
            break;
        }
        boots.push(r.bootMs);
        if (r.entryMs !== null) entries.push(r.entryMs);
        console.log(`${name} dev ${i + 1}/${RUNS}: boot ${r.bootMs}ms, entry ${r.entryMs}ms`);
    }

    clearCaches(app);
    const cold = buildRun(app, t.build, t.outDir);
    console.log(`${name} build cold: ${cold.ms}ms (exit ${cold.status})`);
    const warm = [];
    for (let i = 0; i < RUNS; i++) {
        const b = buildRun(app, t.build, t.outDir);
        warm.push(b.ms);
        console.log(`${name} build warm ${i + 1}/${RUNS}: ${b.ms}ms (exit ${b.status})`);
    }

    out[name] = {
        bootMs: boots.length ? median(boots) : null,
        entryMs: entries.length ? median(entries) : null,
        buildColdMs: cold.ms,
        buildWarmMs: median(warm),
        buildExit: cold.status,
        jsBytes: cold.js,
        brBytes: cold.br,
    };
}

const rows = [
    ['dev cold boot', 'bootMs', 'ms'],
    ['entry transform', 'entryMs', 'ms'],
    ['build (cold)', 'buildColdMs', 'ms'],
    ['build (warm)', 'buildWarmMs', 'ms'],
    ['bundle JS', 'jsBytes', 'B'],
    ['bundle .br', 'brBytes', 'B'],
];
console.log(`\n${'metric'.padEnd(18)}${'lunx'.padStart(12)}${'vite'.padStart(12)}`);
for (const [label, key, unit] of rows) {
    const l = out.lunx?.[key];
    const v = out.vite?.[key];
    const fmt = (x) => (x === null || x === undefined ? '-' : `${x}${unit}`);
    console.log(`${label.padEnd(18)}${fmt(l).padStart(12)}${fmt(v).padStart(12)}`);
}

const reportDir = path.join(REPO, 'reports');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'BENCH_VS_VITE.json'), JSON.stringify(out, null, 2));
console.log(`\nreport: reports${path.sep}BENCH_VS_VITE.json`);

if (!KEEP) fs.rmSync(app, { recursive: true, force: true });
else console.log(`kept: ${app}`);
