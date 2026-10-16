#!/usr/bin/env node
/**
 * Build output, lunx against Vite (both on Rolldown), framework by framework.
 *
 * Each app is the same in every framework: a reactive component, plus probes
 * for global CSS, a CSS module, an image emitted as a file, a JSON named
 * import (the rest of the JSON must be tree-shaken), a lazy chunk, a module
 * worker, an env variable, and dev-only code (must be gone). Both tools build
 * it; both builds are served and checked in Chromium; then the outputs are
 * compared: JS and CSS bytes (raw and gzip), chunks, emitted assets.
 *
 * A "loss" is anything lunx does worse: a probe that fails, a leaked marker,
 * a missing lazy chunk, or JS / CSS larger than Vite's beyond a small margin.
 *
 *   node scripts/output-parity.mjs [--only=react,vue] [--tarball=lunx-dev.tgz] [--keep]
 *
 * Writes reports/OUTPUT_PARITY.json.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = flag('only')?.split(',');
const keep = process.argv.includes('--keep');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-parity-'));
const log = (...a) => console.log(...a);

function run(cmd, args, cwd, timeout = 300_000, env = {}) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, env: { ...process.env, NO_COLOR: '1', ...env }, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

/** An 80×80 greyscale PNG of noise: too big to inline (> 4 kB), so both tools emit it as a file. */
function noisePng(size = 80) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buf) => {
        let c = ~0;
        for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
        return ~c >>> 0;
    };
    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const out = Buffer.alloc(body.length + 8);
        out.writeUInt32BE(data.length, 0);
        body.copy(out, 4);
        out.writeUInt32BE(crc(body), body.length + 4);
        return out;
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 0;
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, rand))])));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

// ── The app ──────────────────────────────────────────────────────────────────

const UNUSED_JSON = 'UNUSED_JSON_' + 'x'.repeat(64);
const COMMON_FILES = {
    'index.html': `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>parity</title></head>
  <body>
    <div id="root"></div>
    <div id="probes">
      <p id="css" class="css-ok">css</p>
      <p id="module">module</p>
      <img id="img" alt="" />
      <p id="json"></p>
      <p id="lazy"></p>
      <p id="worker"></p>
      <p id="env"></p>
    </div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
`,
    '.env': 'VITE_GREETING=env-ok\n',
    'src/shared.css': '.css-ok { color: rgb(0, 187, 119); }\n',
    'src/card.module.css': '.card { border-left: 3px solid rgb(10, 20, 30); }\n',
    'src/photo.png': noisePng(),
    'src/data.json': JSON.stringify({ greeting: 'json-ok', unused: UNUSED_JSON }),
    'src/util.js': "export const label = (text) => `[${text}]`;\n",
    'src/lazy.js': "import { label } from './util.js';\nexport const lazyText = label('lazy-ok');\n",
    'src/worker.js': "self.postMessage('worker-ok');\n",
    'src/probes.js': `import './shared.css';
import styles from './card.module.css';
import photo from './photo.png';
import { greeting } from './data.json';
import { label } from './util.js';

export function runProbes() {
  document.getElementById('module').className = styles.card;
  document.getElementById('img').src = photo;
  document.getElementById('json').textContent = greeting;
  document.getElementById('env').textContent = import.meta.env.VITE_GREETING;
  if (import.meta.env.DEV) console.log('DEV_ONLY_MARKER');
  import('./lazy.js').then((m) => { document.getElementById('lazy').textContent = m.lazyText; });
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => { document.getElementById('worker').textContent = e.data; };
  return label('probes');
}
`,
};

/** Per framework: packages, the Vite plugin, and the component (#fw: "fw-ok", a counter button). */
const FRAMEWORKS = [
    {
        name: 'vanilla',
        packages: [],
        vite: { imports: '', plugins: '' },
        files: {
            'src/main.js': `import { runProbes } from './probes.js';
runProbes();
const root = document.getElementById('root');
root.innerHTML = '<p id="fw" style="font-weight: 700">fw-ok</p><button id="count">count 0</button>';
let n = 0;
root.querySelector('#count').addEventListener('click', (e) => { e.target.textContent = 'count ' + ++n; });
`,
        },
    },
    {
        name: 'react',
        packages: ['react', 'react-dom', '@vitejs/plugin-react'],
        vite: { imports: "import react from '@vitejs/plugin-react';", plugins: 'react()' },
        files: {
            'src/main.js': "import { runProbes } from './probes.js';\nimport { mount } from './App.jsx';\nrunProbes();\nmount(document.getElementById('root'));\n",
            'src/App.jsx': `import { useState } from 'react';
import { createRoot } from 'react-dom/client';
function App() {
  const [n, setN] = useState(0);
  return <><p id="fw" style={{ fontWeight: 700 }}>fw-ok</p><button id="count" onClick={() => setN(n + 1)}>count {n}</button></>;
}
export const mount = (el) => createRoot(el).render(<App />);
`,
        },
    },
    {
        name: 'preact',
        packages: ['preact', '@preact/preset-vite'],
        vite: { imports: "import preact from '@preact/preset-vite';", plugins: 'preact()' },
        files: {
            'src/main.js': "import { runProbes } from './probes.js';\nimport { mount } from './App.jsx';\nrunProbes();\nmount(document.getElementById('root'));\n",
            'src/App.jsx': `import { render } from 'preact';
import { useState } from 'preact/hooks';
function App() {
  const [n, setN] = useState(0);
  return <><p id="fw" style={{ fontWeight: 700 }}>fw-ok</p><button id="count" onClick={() => setN(n + 1)}>count {n}</button></>;
}
export const mount = (el) => render(<App />, el);
`,
        },
    },
    {
        name: 'vue',
        packages: ['vue', '@vitejs/plugin-vue'],
        vite: { imports: "import vue from '@vitejs/plugin-vue';", plugins: 'vue()' },
        files: {
            'src/main.js': "import { createApp } from 'vue';\nimport { runProbes } from './probes.js';\nimport App from './App.vue';\nrunProbes();\ncreateApp(App).mount('#root');\n",
            'src/App.vue': `<script setup>
import { ref } from 'vue';
const n = ref(0);
</script>

<template>
  <p id="fw" class="fw">fw-ok</p>
  <button id="count" @click="n++">count {{ n }}</button>
  <p id="scss" class="scss">scss</p>
  <p id="cssmod" :class="$style.mod">module</p>
</template>

<style scoped>
.fw { font-weight: 700; }
</style>

<style lang="scss" scoped>
$accent: rgb(1, 2, 3);
.scss { color: $accent; }
</style>

<style module>
.mod { text-decoration-line: underline; }
</style>
`,
        },
        extra: [['#scss', 'color', 'rgb(1, 2, 3)'], ['#cssmod', 'textDecorationLine', 'underline']],
    },
    {
        name: 'svelte',
        packages: ['svelte', '@sveltejs/vite-plugin-svelte'],
        vite: { imports: "import { svelte } from '@sveltejs/vite-plugin-svelte';", plugins: 'svelte()' },
        files: {
            'src/main.js': "import { mount } from 'svelte';\nimport { runProbes } from './probes.js';\nimport App from './App.svelte';\nrunProbes();\nmount(App, { target: document.getElementById('root') });\n",
            'src/App.svelte': `<script>
  let n = $state(0);
</script>

<p id="fw" class="fw">fw-ok</p>
<button id="count" onclick={() => n++}>count {n}</button>
<p id="scss" class="scss">scss</p>

<style lang="scss">
  $accent: rgb(1, 2, 3);
  .fw { font-weight: 700; }
  .scss { color: $accent; }
</style>
`,
            'svelte.config.js': "import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';\nexport default { preprocess: vitePreprocess() };\n",
        },
        extra: [['#scss', 'color', 'rgb(1, 2, 3)']],
    },
    {
        name: 'solid',
        packages: ['solid-js', 'vite-plugin-solid'],
        vite: { imports: "import solid from 'vite-plugin-solid';", plugins: 'solid()' },
        files: {
            'src/main.js': "import { runProbes } from './probes.js';\nimport { mount } from './App.jsx';\nrunProbes();\nmount(document.getElementById('root'));\n",
            'src/App.jsx': `import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
function App() {
  const [n, setN] = createSignal(0);
  return <><p id="fw" style={{ 'font-weight': 700 }}>fw-ok</p><button id="count" onClick={() => setN(n() + 1)}>count {n()}</button></>;
}
export const mount = (el) => render(() => <App />, el);
`,
        },
    },
    {
        name: 'lit',
        packages: ['lit'],
        vite: { imports: '', plugins: '' },
        files: {
            'src/main.js': "import { runProbes } from './probes.js';\nimport './counter.js';\nrunProbes();\ndocument.getElementById('root').innerHTML = '<parity-counter></parity-counter>';\n",
            'src/counter.js': `import { LitElement, html, css } from 'lit';
class ParityCounter extends LitElement {
  static properties = { n: { state: true } };
  static styles = css\`#fw { font-weight: 700; }\`;
  constructor() { super(); this.n = 0; }
  render() { return html\`<p id="fw">fw-ok</p><button id="count" @click=\${() => this.n++}>count \${this.n}</button>\`; }
}
customElements.define('parity-counter', ParityCounter);
`,
        },
    },
];


/**
 * A bigger app (React): two pages, base `/sub/`, source maps, two lazy routes that share a module
 * and bring their own CSS, CSS `@import` and `url()`, `public/`, and a worker with imports.
 */
const APP = {
    name: 'app',
    packages: ['react', 'react-dom', '@vitejs/plugin-react'],
    vite: {
        imports: "import react from '@vitejs/plugin-react';",
        plugins: 'react()',
        options: "base: '/sub/', build: { sourcemap: true, rollupOptions: { input: { main: 'index.html', about: 'about.html' } } },",
    },
    files: {
        'index.html': `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>app</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>
</html>
`,
        'about.html': `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>about</title></head>
  <body><p id="about"></p><script type="module" src="/src/about.js"></script></body>
</html>
`,
        'public/robots.txt': 'User-agent: *\n',
        'src/bg.png': noisePng(64),
        'src/base.css': '.base { letter-spacing: 3px; }\n',
        'src/theme.css': "@import './base.css';\n.bg { background-image: url('./bg.png'); width: 10px; height: 10px; }\n",
        'src/routes/shared.js': "export const SHARED_MARKER = 'shared-module-ok';\n",
        'src/routes/a.css': '.route-a { color: rgb(11, 22, 33); }\n',
        'src/routes/b.css': '.route-b { color: rgb(44, 55, 66); }\n',
        'src/routes/a.jsx': "import './a.css';\nimport { SHARED_MARKER } from './shared.js';\nexport default function A() { return <p id=\"route\" className=\"route-a\">A {SHARED_MARKER}</p>; }\n",
        'src/routes/b.jsx': "import './b.css';\nimport { SHARED_MARKER } from './shared.js';\nexport default function B() { return <p id=\"route\" className=\"route-b\">B {SHARED_MARKER}</p>; }\n",
        'src/math.js': 'export const square = (n) => n * n;\n',
        'src/worker.js': "import { square } from './math.js';\nself.postMessage('worker ' + square(7));\n",
        'src/about.js': "import { SHARED_MARKER } from './routes/shared.js';\ndocument.getElementById('about').textContent = 'about ' + SHARED_MARKER;\n",
        'src/main.jsx': `import { lazy, Suspense, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
const A = lazy(() => import('./routes/a.jsx'));
const B = lazy(() => import('./routes/b.jsx'));
function App() {
  const [route, setRoute] = useState(null);
  const [worker, setWorker] = useState('');
  useEffect(() => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => setWorker(e.data);
  }, []);
  return <>
    <p id="base" className="base">base</p>
    <div id="bg" className="bg" />
    <p id="worker">{worker}</p>
    <button id="to-a" onClick={() => setRoute('a')}>a</button>
    <button id="to-b" onClick={() => setRoute('b')}>b</button>
    <Suspense fallback={<p>loading</p>}>{route === 'a' ? <A /> : route === 'b' ? <B /> : null}</Suspense>
  </>;
}
createRoot(document.getElementById('root')).render(<App />);
`,
    },
};

async function checkApp(browser, origin) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.location()?.url ?? '') && errors.push(m.text()));
    const failures = [];
    const want = async (name, fn) => {
        try {
            await fn();
        } catch (e) {
            failures.push(`${name}: ${String(e.message).split('\n')[0]}`);
        }
    };
    const style = (sel, prop) => page.evaluate(([s, p]) => (document.querySelector(s) ? getComputedStyle(document.querySelector(s))[p] : null), [sel, prop]);
    const text = (sel, value) => page.waitForFunction(([s, v]) => document.querySelector(s)?.textContent.trim() === v, [sel, value], { timeout: 10_000 });
    try {
        await page.goto(origin + '/sub/', { waitUntil: 'load', timeout: 30_000 });
        await want('css @import', async () => {
            const v = await style('#base', 'letterSpacing');
            if (v !== '3px') throw new Error(`letter-spacing ${v}`);
        });
        await want('css url()', async () => {
            const bg = await style('#bg', 'backgroundImage');
            const url = bg?.match(/url\("?([^")]+)"?\)/)?.[1];
            if (!url) throw new Error(`background-image ${bg}`);
            const res = await page.evaluate((u) => fetch(u).then((r) => r.status), url);
            if (res !== 200) throw new Error(`${url}: HTTP ${res}`);
        });
        await want('worker with imports', () => text('#worker', 'worker 49'));
        await want('lazy route a + its css', async () => {
            await page.click('#to-a');
            await text('#route', 'A shared-module-ok');
            const c = await style('#route', 'color');
            if (c !== 'rgb(11, 22, 33)') throw new Error(`color ${c}`);
        });
        await want('lazy route b + its css', async () => {
            await page.click('#to-b');
            await text('#route', 'B shared-module-ok');
            const c = await style('#route', 'color');
            if (c !== 'rgb(44, 55, 66)') throw new Error(`color ${c}`);
        });
        await want('public/', async () => {
            const res = await page.evaluate(() => fetch('/sub/robots.txt').then((r) => r.status));
            if (res !== 200) throw new Error(`HTTP ${res}`);
        });
        await want('second page', async () => {
            await page.goto(origin + '/sub/about.html', { waitUntil: 'load', timeout: 30_000 });
            await text('#about', 'about shared-module-ok');
        });
        if (errors.length) failures.push(`console: ${errors.slice(0, 2).join(' | ')}`);
    } catch (e) {
        failures.push(`load: ${e.message.split('\n')[0]}`);
    } finally {
        await page.close();
    }
    return failures;
}

/** What the app's build does with code splitting, CSS splitting and source maps. */
function appShape(dist) {
    const files = filesIn(dist).filter((f) => !REPORT_FILES.test(path.posix.basename(f)) || f.endsWith('.map'));
    const read = (f) => fs.readFileSync(path.join(dist, f), 'utf8');
    const js = files.filter((f) => /\.m?js$/.test(f));
    const index = read('index.html');
    const initialCss = [...index.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1].replace(/^\/sub\//, ''));
    const initialCssText = initialCss.map((f) => (fs.existsSync(path.join(dist, f)) ? read(f) : '')).join('');
    return {
        sharedModuleCopies: js.filter((f) => read(f).includes('shared-module-ok')).length,
        routeCssInInitialCss: /rgb\(11,\s*22,\s*33\)|#0b1621/.test(initialCssText),
        initialCssGzip: zlib.gzipSync(initialCssText, { level: 9 }).length,
        jsWithoutMap: js.filter((f) => !files.includes(f + '.map')).length,
        jsWithoutMapComment: js.filter((f) => !/\/\/# sourceMappingURL=/.test(read(f))).length,
        aboutPage: files.includes('about.html'),
    };
}

// ── Measuring and checking ───────────────────────────────────────────────────

function filesIn(dir, root = dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...filesIn(full, root));
        else out.push(path.relative(root, full).split(path.sep).join('/'));
    }
    return out;
}

const REPORT_FILES = /^(lunx-[\w-]+\.(json|txt|html)|_headers|_redirects)$|\.(gz|br|map)$/;

function measure(dist) {
    const files = filesIn(dist).filter((f) => !REPORT_FILES.test(path.posix.basename(f)));
    const sum = (list, fn) => list.reduce((n, f) => n + fn(fs.readFileSync(path.join(dist, f))), 0);
    const js = files.filter((f) => /\.m?js$/.test(f));
    const css = files.filter((f) => f.endsWith('.css'));
    const gz = (b) => zlib.gzipSync(b, { level: 9 }).length;
    const jsText = js.map((f) => fs.readFileSync(path.join(dist, f), 'utf8')).join('\n');
    return {
        jsFiles: js.length,
        jsBytes: sum(js, (b) => b.length),
        jsGzip: sum(js, gz),
        cssFiles: css.length,
        cssBytes: sum(css, (b) => b.length),
        cssGzip: sum(css, gz),
        assets: files.filter((f) => !/\.(m?js|css|html)$/.test(f)).sort(),
        htmlBytes: sum(files.filter((f) => f.endsWith('.html')), (b) => b.length),
        devCodeLeft: jsText.includes('DEV_ONLY_MARKER'),
        unusedJsonLeft: jsText.includes('UNUSED_JSON_'),
    };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };

function serve(dist, base = '/') {
    const server = http.createServer((req, res) => {
        const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        let file = path.join(dist, pathname.startsWith(base) ? pathname.slice(base.length - 1) : pathname);
        if (file.endsWith(path.sep) || !path.extname(file)) file = path.join(dist, 'index.html');
        if (!file.startsWith(dist) || !fs.existsSync(file)) {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        res.end(fs.readFileSync(file));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}

/** Every probe in Chromium; returns the failures. */
async function check(browser, url, extra = []) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.location()?.url ?? '') && errors.push(m.text()));
    const failures = [];
    const want = async (name, fn) => {
        try {
            await fn();
        } catch (e) {
            failures.push(`${name}: ${String(e.message).split('\n')[0]}`);
        }
    };
    try {
        await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
        const text = (sel, value) => page.waitForFunction(([s, v]) => {
            const host = document.querySelector('parity-counter');
            const el = document.querySelector(s) ?? host?.shadowRoot?.querySelector(s);
            return el && el.textContent.trim() === v;
        }, [sel, value], { timeout: 10_000 });
        const style = (sel, prop) => page.evaluate(([s, p]) => {
            const host = document.querySelector('parity-counter');
            const el = document.querySelector(s) ?? host?.shadowRoot?.querySelector(s);
            return el ? getComputedStyle(el)[p] : null;
        }, [sel, prop]);
        await want('component', () => text('#fw', 'fw-ok'));
        await want('component style', async () => {
            const w = await style('#fw', 'fontWeight');
            if (w !== '700') throw new Error(`font-weight ${w}`);
        });
        await want('reactivity', async () => {
            const host = await page.$('parity-counter');
            if (host) await page.evaluate(() => document.querySelector('parity-counter').shadowRoot.querySelector('#count').click());
            else await page.click('#count');
            await text('#count', 'count 1');
        });
        await want('global css', async () => {
            const c = await style('#css', 'color');
            if (c !== 'rgb(0, 187, 119)') throw new Error(`color ${c}`);
        });
        await want('css module', async () => {
            const c = await style('#module', 'borderLeftColor');
            if (c !== 'rgb(10, 20, 30)') throw new Error(`border ${c}`);
        });
        await want('image', async () => {
            await page.waitForFunction(() => document.getElementById('img').complete, null, { timeout: 10_000 });
            const w = await page.evaluate(() => document.getElementById('img').naturalWidth);
            if (w !== 80) throw new Error(`naturalWidth ${w}`);
        });
        for (const [sel, prop, value] of extra) {
            await want(`style ${sel}`, async () => {
                const got = await style(sel, prop);
                if (got !== value) throw new Error(`${prop} ${got}`);
            });
        }
        await want('json', () => text('#json', 'json-ok'));
        await want('env', () => text('#env', 'env-ok'));
        await want('lazy chunk', () => text('#lazy', '[lazy-ok]'));
        await want('worker', () => text('#worker', 'worker-ok'));
        if (errors.length) failures.push(`console: ${errors.slice(0, 2).join(' | ')}`);
    } catch (e) {
        failures.push(`load: ${e.message.split('\n')[0]}`);
    } finally {
        await page.close();
    }
    return failures;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const frameworks = FRAMEWORKS.filter((f) => !only || only.includes(f.name));
let tarball = flag('tarball') && path.resolve(flag('tarball'));
if (!tarball) {
    log('packing lunx-dev…');
    const packed = run('npm', ['pack', '--pack-destination', WORK, '--silent'], REPO);
    if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.output}`);
    tarball = path.join(WORK, packed.output.trim().split('\n').pop());
}
const shared = path.join(WORK, 'shared');
fs.mkdirSync(shared);
fs.writeFileSync(path.join(shared, 'package.json'), JSON.stringify({ name: 'parity-shared', private: true, type: 'module' }));
const withApp = !only || only.includes('app');
const packages = [...new Set(['vite', 'sass', ...frameworks.flatMap((f) => f.packages), ...(withApp ? APP.packages : [])])];
log(`installing lunx-dev, vite and ${packages.length - 1} packages…`);
const install = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--legacy-peer-deps', tarball, ...packages], shared, 900_000); // every framework's Vite plugin in one tree: their optional peers clash
if (install.code !== 0) throw new Error(`npm install failed:\n${install.output}`);
const version = (p) => JSON.parse(fs.readFileSync(path.join(shared, 'node_modules', p, 'package.json'), 'utf8')).version;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const results = [];
for (const fw of frameworks) {
    const dir = path.join(WORK, fw.name);
    const files = {
        ...COMMON_FILES,
        ...fw.files,
        'package.json': JSON.stringify({ name: `parity-${fw.name}`, private: true, type: 'module', dependencies: Object.fromEntries(fw.packages.filter((p) => !/plugin|preset/.test(p)).map((p) => [p, version(p)])) }),
        'vite.config.js': `import { defineConfig } from 'vite';\n${fw.vite.imports}\nexport default defineConfig({ plugins: [${fw.vite.plugins}] });\n`,
    };
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    fs.symlinkSync(path.join(shared, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

    const result = { framework: fw.name, lunx: {}, vite: {}, losses: [] };
    for (const [tool, args] of [
        ['lunx', ['node_modules/lunx-dev/dist/cli.js', 'build', '--outDir', 'dist-lunx']],
        ['vite', ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-vite']],
    ]) {
        const started = Date.now();
        const built = run(process.execPath, args, dir, 300_000, { NODE_ENV: 'production', LUNX_SKIP_SECURITY: '1' });
        const ms = Date.now() - started;
        if (built.code !== 0) {
            result[tool] = { error: built.output.trim().split('\n').slice(-6).join(' ') };
            continue;
        }
        const dist = path.join(dir, `dist-${tool}`);
        const server = await serve(dist);
        const failures = await check(browser, server.url, fw.extra);
        server.close();
        result[tool] = { buildMs: ms, ...measure(dist), failures };
    }

    const l = result.lunx;
    const v = result.vite;
    if (l.error) result.losses.push(`lunx build failed: ${l.error}`);
    else {
        for (const f of l.failures) if (!v.failures?.includes(f)) result.losses.push(`lunx: ${f}`);
        if (l.devCodeLeft) result.losses.push('dev-only code left in the build');
        if (l.unusedJsonLeft && !v.unusedJsonLeft) result.losses.push('unused JSON not tree-shaken');
        if (!v.error) {
            if (l.jsFiles < v.jsFiles) result.losses.push(`fewer JS chunks (${l.jsFiles} vs ${v.jsFiles})`);
            if (l.jsGzip > v.jsGzip * 1.01 + 100) result.losses.push(`JS gzip ${l.jsGzip} vs ${v.jsGzip} (+${l.jsGzip - v.jsGzip} B)`);
            if (l.cssGzip > v.cssGzip * 1.02 + 30) result.losses.push(`CSS gzip ${l.cssGzip} vs ${v.cssGzip} (+${l.cssGzip - v.cssGzip} B)`);
            if (l.assets.length < v.assets.length) result.losses.push(`assets ${l.assets.join(', ')} vs ${v.assets.join(', ')}`);
        }
    }
    results.push(result);
    const fmt = (m) => (m.error ? 'BUILD FAILED' : `js ${m.jsFiles} files ${m.jsGzip} B gz, css ${m.cssGzip} B gz, ${m.failures.length ? `✗ ${m.failures.length} probes` : 'all probes ok'}`);
    log(`${result.losses.length ? '✗' : '✓'} ${fw.name.padEnd(8)} lunx: ${fmt(l)} | vite: ${fmt(v)}`);
    for (const loss of result.losses) log(`    loss: ${loss}`);
}
if (withApp) {
    const dir = path.join(WORK, 'app');
    const files = {
        ...APP.files,
        'package.json': JSON.stringify({ name: 'parity-app', private: true, type: 'module', dependencies: { react: version('react'), 'react-dom': version('react-dom') } }),
        'vite.config.js': `import { defineConfig } from 'vite';\n${APP.vite.imports}\nexport default defineConfig({ ${APP.vite.options} plugins: [${APP.vite.plugins}] });\n`,
    };
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    fs.symlinkSync(path.join(shared, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const result = { framework: 'app', lunx: {}, vite: {}, losses: [] };
    for (const [tool, args] of [
        ['lunx', ['node_modules/lunx-dev/dist/cli.js', 'build', '--outDir', 'dist-lunx']],
        ['vite', ['node_modules/vite/bin/vite.js', 'build', '--outDir', 'dist-vite']],
    ]) {
        const started = Date.now();
        const built = run(process.execPath, args, dir, 300_000, { NODE_ENV: 'production', LUNX_SKIP_SECURITY: '1' });
        if (built.code !== 0) {
            result[tool] = { error: built.output.trim().split('\n').slice(-6).join(' ') };
            continue;
        }
        const dist = path.join(dir, `dist-${tool}`);
        const server = await serve(dist, '/sub/');
        const failures = await checkApp(browser, server.url.replace(/\/$/, ''));
        server.close();
        result[tool] = { buildMs: Date.now() - started, ...measure(dist), ...appShape(dist), failures };
    }
    const l = result.lunx;
    const v = result.vite;
    if (l.error) result.losses.push(`lunx build failed: ${l.error}`);
    else {
        for (const f of l.failures) if (!v.failures?.includes(f)) result.losses.push(`lunx: ${f}`);
        if (l.sharedModuleCopies > 1) result.losses.push(`shared module in ${l.sharedModuleCopies} chunks`);
        if (!l.aboutPage) result.losses.push('second page not built');
        if (l.jsWithoutMap || l.jsWithoutMapComment) result.losses.push(`source maps: ${l.jsWithoutMap} JS files without a .map, ${l.jsWithoutMapComment} without a sourceMappingURL`);
        if (!v.error) {
            if (l.routeCssInInitialCss && !v.routeCssInInitialCss) result.losses.push(`lazy routes' CSS loaded up front (initial CSS ${l.initialCssGzip} vs ${v.initialCssGzip} B gz)`);
            if (l.jsGzip > v.jsGzip * 1.01 + 100) result.losses.push(`JS gzip ${l.jsGzip} vs ${v.jsGzip}`);
        }
    }
    results.push(result);
    const fmt = (m) => (m.error ? 'BUILD FAILED' : `js ${m.jsFiles} files ${m.jsGzip} B gz, initial css ${m.initialCssGzip} B gz, ${m.failures.length ? `✗ ${m.failures.join('; ')}` : 'all probes ok'}`);
    log(`${result.losses.length ? '✗' : '✓'} app      lunx: ${fmt(l)} | vite: ${fmt(v)}`);
    for (const loss of result.losses) log(`    loss: ${loss}`);
}
await browser.close();

const report = { lunx: version('lunx-dev'), vite: version('vite'), node: process.version, results };
fs.writeFileSync(path.join(REPO, 'reports', 'OUTPUT_PARITY.json'), JSON.stringify(report, null, 2) + '\n');
const lost = results.filter((r) => r.losses.length);
log(`\n${results.length - lost.length}/${results.length} scenarios with no loss to Vite`);
if (!keep) fs.rmSync(WORK, { recursive: true, force: true });
else log(`kept in ${WORK}`);
process.exitCode = lost.length ? 1 : 0;
