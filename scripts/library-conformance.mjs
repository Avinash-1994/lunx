/**
 * Library conformance: the module shapes that break real apps.
 *
 * One app imports a set of local packages, each written in a shape found on
 * npm (CommonJS only, ESM only, dual, `exports` conditions and patterns,
 * `#imports`, the legacy `browser` field, …) plus app-level features (JSON,
 * workers, wasm, dynamic import, top-level await). The page writes one line
 * per case; the suite checks every line in `lunx dev` and in the production
 * build, in real Chromium.
 *
 * Run: npx tsx scripts/library-conformance.mjs [--keep]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');
const keep = process.argv.includes('--keep');

// ── Packages ────────────────────────────────────────────────────────────────

const pkg = (name, manifest, files) => ({ name, manifest: { name, version: '1.0.0', ...manifest }, files });

const PACKAGES = [
    pkg('cjs-only', { main: 'index.js' }, {
        'index.js': `exports.hello = function () { return 'cjs-named'; };\nexports.answer = 42;\n`,
    }),
    pkg('cjs-fn', { main: 'index.js' }, {
        'index.js': `module.exports = function greet() { return 'cjs-default-fn'; };\n`,
    }),
    pkg('cjs-esmodule', { main: 'index.js' }, {
        'index.js': `Object.defineProperty(exports, '__esModule', { value: true });\nexports.default = 'cjs-esmodule-default';\nexports.named = 'cjs-esmodule-named';\n`,
    }),
    pkg('cjs-env', { main: 'index.js' }, {
        // The React pattern: pick a build from NODE_ENV, at require time.
        'index.js': `if (process.env.NODE_ENV === 'production') { module.exports = require('./prod.js'); } else { module.exports = require('./dev.js'); }\n`,
        'prod.js': `module.exports = { mode: 'env-ok' };\n`,
        'dev.js': `module.exports = { mode: 'env-ok' };\n`,
    }),
    pkg('esm-only', { type: 'module', exports: './index.js' }, {
        'index.js': `export const esm = 'esm-only';\nexport default 'esm-default';\n`,
    }),
    pkg('dual', {
        exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } },
        main: './cjs.cjs',
    }, {
        'esm.mjs': `export const which = 'dual-esm';\n`,
        'cjs.cjs': `exports.which = 'dual-cjs';\n`,
    }),
    pkg('conditions', {
        exports: { '.': { types: './index.d.ts', node: './node.js', browser: './browser.js', default: './node.js' } },
    }, {
        'browser.js': `export const where = 'browser-condition';\n`,
        'node.js': `export const where = 'node-condition';\n`,
    }),
    pkg('patterns', {
        type: 'module',
        exports: { '.': './index.js', './features/*': './src/features/*.js', './package.json': './package.json' },
    }, {
        'index.js': `export const root = 'patterns-root';\n`,
        'src/features/alpha.js': `export const feature = 'pattern-subpath';\n`,
    }),
    pkg('hash-imports', {
        type: 'module',
        exports: './index.js',
        imports: { '#internal': { browser: './internal-browser.js', default: './internal-node.js' } },
    }, {
        'index.js': `export { value } from '#internal';\n`,
        'internal-browser.js': `export const value = 'hash-imports-browser';\n`,
        'internal-node.js': `export const value = 'hash-imports-node';\n`,
    }),
    pkg('legacy-browser-field', { main: 'node.js', browser: { './node.js': './browser.js' } }, {
        'node.js': `module.exports = 'legacy-node';\n`,
        'browser.js': `module.exports = 'legacy-browser';\n`,
    }),
    pkg('module-field', { main: 'cjs.js', module: 'esm.js' }, {
        'cjs.js': `exports.kind = 'main-field';\n`,
        'esm.js': `export const kind = 'module-field';\n`,
    }),
    pkg('cjs-chain', { main: 'index.js' }, {
        'index.js': `const inner = require('./lib/inner');\nmodule.exports = { chain: inner.value + '-chain' };\n`,
        'lib/inner.js': `exports.value = 'cjs';\n`,
    }),
];

// A module that adds two i32s: (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
const ADD_WASM = Buffer.from('0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b', 'hex');

const CASES = {
    'cjs-named': 'cjs-named',
    'cjs-number': '42',
    'cjs-default-fn': 'cjs-default-fn',
    'cjs-esmodule': 'cjs-esmodule-default/cjs-esmodule-named',
    'cjs-env': 'env-ok',
    'esm-only': 'esm-only/esm-default',
    'dual': 'dual-esm',
    'conditions': 'browser-condition',
    'patterns': 'patterns-root/pattern-subpath',
    'hash-imports': 'hash-imports-browser',
    'legacy-browser-field': 'legacy-browser',
    'module-field': 'module-field',
    'cjs-chain': 'cjs-chain',
    'json': 'json-ok',
    'dynamic-import': 'lazy-ok',
    'top-level-await': 'tla-ok',
    'worker': 'worker-ok',
    'wasm': '5',
    'asset-url': 'asset-url-ok',
    'glob-lazy': './glob/a.ts,./glob/b.ts:a+b',
    'glob-eager': 'en,fr',
    'glob-raw': 'raw-ok',
    'raw-import': 'asset-url-ok',
};

const MAIN = `import { hello, answer } from 'cjs-only';
import greet from 'cjs-fn';
import esmodDefault, { named as esmodNamed } from 'cjs-esmodule';
import envPkg from 'cjs-env';
import esmDefault, { esm } from 'esm-only';
import { which } from 'dual';
import { where } from 'conditions';
import { root } from 'patterns';
import { feature } from 'patterns/features/alpha';
import { value as hashValue } from 'hash-imports';
import legacy from 'legacy-browser-field';
import { kind } from 'module-field';
import chainPkg from 'cjs-chain';
import data from './data.json';
import wasmUrl from './add.wasm?url';
import noteRaw from './note.txt?raw';

const out = document.getElementById('out')!;
const report = (name: string, value: unknown) => {
  const line = document.createElement('div');
  line.textContent = name + '=' + String(value);
  out.appendChild(line);
};
const attempt = async (name: string, fn: () => unknown) => {
  try { report(name, await fn()); } catch (e) { report(name, 'ERROR ' + (e as Error).message); }
};

await attempt('cjs-named', () => hello());
await attempt('cjs-number', () => answer);
await attempt('cjs-default-fn', () => greet());
await attempt('cjs-esmodule', () => esmodDefault + '/' + esmodNamed);
await attempt('cjs-env', () => envPkg.mode);
await attempt('esm-only', () => esm + '/' + esmDefault);
await attempt('dual', () => which);
await attempt('conditions', () => where);
await attempt('patterns', () => root + '/' + feature);
await attempt('hash-imports', () => hashValue);
await attempt('legacy-browser-field', () => legacy);
await attempt('module-field', () => kind);
await attempt('cjs-chain', () => chainPkg.chain);
await attempt('json', () => data.status);
await attempt('dynamic-import', async () => (await import('./lazy')).lazy);
await attempt('top-level-await', async () => (await import('./tla')).tla);
await attempt('worker', () => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => resolve(e.data);
  worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
  worker.postMessage('ping');
}));
await attempt('wasm', async () => {
  const bytes = await (await fetch(wasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes);
  return (instance.exports.add as (a: number, b: number) => number)(2, 3);
});
await attempt('asset-url', async () => {
  const text = await (await fetch(new URL('./note.txt', import.meta.url))).text();
  return text.trim();
});
await attempt('glob-lazy', async () => {
  const mods = import.meta.glob('./glob/*.ts');
  const values = await Promise.all(Object.values(mods).map((load) => load().then((m: any) => m.name)));
  return Object.keys(mods).join(',') + ':' + values.join('+');
});
await attempt('glob-eager', () => {
  const mods = import.meta.glob('./i18n/*.json', { eager: true, import: 'default' }) as Record<string, { lang: string }>;
  return Object.values(mods).map((m) => m.lang).join(',');
});
await attempt('glob-raw', async () => {
  const mods = import.meta.glob('./glob/*.txt', { query: '?raw', import: 'default' });
  return (await Object.values(mods)[0]!() as string).trim();
});
await attempt('raw-import', () => noteRaw.trim());
document.body.dataset.done = '1';
`;

const APP_FILES = {
    'index.html': `<!DOCTYPE html>\n<html><head><meta charset="UTF-8" /><title>conformance</title></head>\n<body><div id="out"></div><script type="module" src="/src/main.ts"></script></body></html>\n`,
    'src/main.ts': MAIN,
    'src/data.json': JSON.stringify({ status: 'json-ok' }),
    'src/lazy.ts': `export const lazy = 'lazy-ok';\n`,
    'src/tla.ts': `const value = await Promise.resolve('tla-ok');\nexport const tla = value;\n`,
    'src/worker.ts': `self.onmessage = () => { (self as any).postMessage('worker-ok'); };\n`,
    'src/note.txt': 'asset-url-ok\n',
    'src/glob/a.ts': `export const name = 'a';\n`,
    'src/glob/b.ts': `export const name = 'b';\n`,
    'src/glob/c.txt': 'raw-ok\n',
    'src/i18n/en.json': JSON.stringify({ lang: 'en' }),
    'src/i18n/fr.json': JSON.stringify({ lang: 'fr' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: false, resolveJsonModule: true } }),
};

// ── Harness ─────────────────────────────────────────────────────────────────

async function scaffold(root) {
    for (const [rel, content] of Object.entries(APP_FILES)) {
        await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fsp.writeFile(path.join(root, rel), content);
    }
    await fsp.writeFile(path.join(root, 'src', 'add.wasm'), ADD_WASM);
    const deps = {};
    for (const p of PACKAGES) {
        const dir = path.join(root, 'node_modules', p.name);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(p.manifest, null, 2));
        for (const [rel, content] of Object.entries(p.files)) {
            await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
            await fsp.writeFile(path.join(dir, rel), content);
        }
        deps[p.name] = '1.0.0';
    }
    await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'conformance', private: true, type: 'module', dependencies: deps }, null, 2));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function runCli(args, cwd, readyPattern, timeoutMs = 120_000) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', LUNX_SKIP_SECURITY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const done = (result) => {
            clearTimeout(timer);
            resolve({ ...result, child, output: () => output });
        };
        const timer = setTimeout(() => done({ code: -1 }), timeoutMs);
        const onData = (d) => {
            output += d;
            if (readyPattern && output.includes(readyPattern)) done({ code: null });
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) => done({ code }));
    });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain', '.svg': 'image/svg+xml' };
function serve(dir, port) {
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        let file = path.join(dir, url === '/' ? 'index.html' : url);
        if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function readCases(browser, url) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForFunction(() => document.body.dataset.done === '1', null, { timeout: 30_000 }).catch(() => {});
        const lines = await page.evaluate(() => [...document.querySelectorAll('#out div')].map((d) => d.textContent));
        return { lines, errors };
    } finally {
        await page.close();
    }
}

function score(label, { lines, errors }) {
    const got = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const rows = Object.entries(CASES).map(([name, expected]) => ({ name, expected, actual: got[name] ?? '(not reached)', pass: got[name] === expected }));
    const passed = rows.filter((r) => r.pass).length;
    console.log(`\n${label}: ${passed}/${rows.length}`);
    for (const r of rows) if (!r.pass) console.log(`  ✗ ${r.name.padEnd(22)} expected ${r.expected}, got ${r.actual}`);
    for (const e of errors.slice(0, 3)) console.log(`  ! pageerror: ${e}`);
    return { rows, passed, total: rows.length };
}

// ── Run ─────────────────────────────────────────────────────────────────────

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lunx-conformance-'));
await scaffold(root);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const results = {};
try {
    const port = await freePort();
    const dev = await runCli(['dev', '--root', root, '--port', String(port)], REPO, 'ready in');
    results.dev = score('dev', await readCases(browser, `http://127.0.0.1:${port}/`));
    dev.child.kill();

    const build = await runCli(['build', '--root', root], REPO, null, 180_000);
    if (build.code !== 0) {
        console.log(`\nbuild failed (exit ${build.code}):\n${build.output().trim().split('\n').slice(-8).join('\n')}`);
        results.build = { passed: 0, total: Object.keys(CASES).length };
    } else {
        const previewPort = await freePort();
        const server = await serve(path.join(root, 'dist'), previewPort);
        results.build = score('build', await readCases(browser, `http://127.0.0.1:${previewPort}/`));
        server.close();
    }
} finally {
    await browser.close();
    if (!keep) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    else console.log(`\nfixture kept at ${root}`);
}

const passed = results.dev.passed + results.build.passed;
const total = results.dev.total + results.build.total;
console.log(`\n${passed}/${total} conformance checks passed`);
await fsp.writeFile(path.join(REPO, 'reports', 'LIBRARY_CONFORMANCE.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
process.exit(passed === total ? 0 : 1);
