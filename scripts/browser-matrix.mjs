/**
 * Cross-framework browser conformance matrix.
 *
 * For every supported framework this script:
 *   1. scaffolds a minimal app in a temp directory,
 *   2. starts `lunx dev` on a free port,
 *   3. loads it in a real Chromium page and asserts the app mounted,
 *   4. asserts CSS was applied and no console errors were logged,
 *   5. edits a source file and asserts the change reaches the browser (HMR),
 *   6. runs `lunx build` and serves `dist/`, asserting the production output
 *      renders the same thing,
 *   7. records dev-server boot, first-paint and build timings.
 *
 * Run: npx tsx scripts/browser-matrix.mjs [--only react,vue] [--headed]
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
// LUNX_CLI=dist/cli.js runs the built CLI with plain node (no tsx).
const CLI = process.env.LUNX_CLI ? path.resolve(REPO, process.env.LUNX_CLI) : path.join(REPO, 'src', 'cli.ts');

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',');
const headed = args.includes('--headed');
const keepTemp = args.includes('--keep');

// ── Fixtures ────────────────────────────────────────────────────────────────

const SHARED_CSS = `:root { --fg: #0b7; }
#app, #root { font-family: system-ui, sans-serif; }
.marker { color: rgb(0, 187, 119); font-weight: 700; }
`;

/**
 * Every app renders `.marker` with the text MARKER_BEFORE, styled green.
 * The HMR step rewrites it to MARKER_AFTER in `hmrFile`.
 */
const MARKER_BEFORE = 'LUNX-OK-BEFORE';
const MARKER_AFTER = 'LUNX-OK-AFTER';

function html(entry, mountId = 'root') {
    return `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>lunx matrix</title></head>
  <body>
    <div id="${mountId}"></div>
    <script type="module" src="/${entry}"></script>
  </body>
</html>
`;
}

const FRAMEWORKS = [
    {
        name: 'vanilla-ts',
        deps: {},
        hmrFile: 'src/app.ts',
        files: {
            'index.html': html('src/main.ts', 'app'),
            'src/index.css': SHARED_CSS,
            'src/main.ts': `import './index.css';\nimport { render } from './app';\nrender(document.getElementById('app')!);\n`,
            'src/app.ts': `export function render(el: HTMLElement) {\n  el.innerHTML = '<h1 class="marker">${MARKER_BEFORE}</h1>';\n}\n`,
        },
    },
    {
        name: 'react',
        deps: { react: '19.2.3', 'react-dom': '19.2.3' },
        hmrFile: 'src/App.tsx',
        files: {
            'index.html': html('src/main.tsx'),
            'src/index.css': SHARED_CSS,
            'src/main.tsx': `import './index.css';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
            'src/App.tsx': `import { useState } from 'react';\nexport default function App() {\n  const [n, setN] = useState(0);\n  return <><h1 className="marker">${MARKER_BEFORE}</h1><button id="inc" onClick={() => setN(n + 1)}>{n}</button></>;\n}\n`,
        },
        interactive: true,
    },
    {
        name: 'preact',
        deps: { preact: '10.29.8' },
        hmrFile: 'src/App.tsx',
        config: `import { defineConfig } from 'lunx';\nexport default defineConfig({ framework: 'preact' });\n`,
        files: {
            'index.html': html('src/main.tsx'),
            'src/index.css': SHARED_CSS,
            'src/main.tsx': `import './index.css';\nimport { render } from 'preact';\nimport App from './App';\nrender(<App />, document.getElementById('root')!);\n`,
            'src/App.tsx': `import { useState } from 'preact/hooks';\nexport default function App() {\n  const [n, setN] = useState(0);\n  return <><h1 class="marker">${MARKER_BEFORE}</h1><button id="inc" onClick={() => setN(n + 1)}>{n}</button></>;\n}\n`,
            'tsconfig.json': JSON.stringify(
                { compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact', target: 'ES2020', module: 'ESNext', moduleResolution: 'bundler', strict: false } },
                null,
                2,
            ),
        },
        interactive: true,
    },
    {
        name: 'vue',
        deps: { vue: '3.5.26' },
        hmrFile: 'src/App.vue',
        files: {
            'index.html': html('src/main.ts'),
            'src/index.css': SHARED_CSS,
            'src/main.ts': `import './index.css';\nimport { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#root');\n`,
            'src/App.vue': `<script setup>\nimport { ref } from 'vue';\nconst n = ref(0);\n</script>\n<template>\n  <h1 class="marker">${MARKER_BEFORE}</h1>\n  <button id="inc" @click="n++">{{ n }}</button>\n</template>\n`,
        },
        interactive: true,
    },
    {
        name: 'svelte',
        deps: { svelte: '5.55.5' },
        hmrFile: 'src/App.svelte',
        files: {
            'index.html': html('src/main.ts'),
            'src/index.css': SHARED_CSS,
            'src/main.ts': `import './index.css';\nimport { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root')! });\n`,
            'src/App.svelte': `<script>\n  let n = $state(0);\n</script>\n<h1 class="marker">${MARKER_BEFORE}</h1>\n<button id="inc" onclick={() => n++}>{n}</button>\n`,
        },
        interactive: true,
    },
    {
        name: 'solid',
        deps: { 'solid-js': '1.9.15' },
        hmrFile: 'src/App.tsx',
        config: `import { defineConfig } from 'lunx';\nexport default defineConfig({ framework: 'solid' });\n`,
        files: {
            'index.html': html('src/main.tsx'),
            'src/index.css': SHARED_CSS,
            'src/main.tsx': `import './index.css';\nimport { render } from 'solid-js/web';\nimport App from './App';\nrender(() => <App />, document.getElementById('root')!);\n`,
            'src/App.tsx': `import { createSignal } from 'solid-js';\nexport default function App() {\n  const [n, setN] = createSignal(0);\n  return <><h1 class="marker">${MARKER_BEFORE}</h1><button id="inc" onClick={() => setN(n() + 1)}>{n()}</button></>;\n}\n`,
        },
        interactive: true,
    },
    {
        name: 'lit',
        deps: { lit: '3.3.3' },
        hmrFile: 'src/app-root.ts',
        files: {
            'index.html': `<!DOCTYPE html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><title>lunx matrix</title></head>\n  <body>\n    <div id="root"><app-root></app-root></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`,
            'src/index.css': SHARED_CSS,
            'src/main.ts': `import './index.css';\nimport './app-root';\n`,
            'src/app-root.ts': `import { LitElement, html, css } from 'lit';\n\nexport class AppRoot extends LitElement {\n  static styles = css\`h1 { color: rgb(0, 187, 119); font-weight: 700; }\`;\n  static properties = { n: { state: true } };\n  constructor() { super(); this.n = 0; }\n  render() { return html\`<h1 class="marker">${MARKER_BEFORE}</h1><button id="inc" @click=\${() => this.n++}>\${this.n}</button>\`; }\n}\ncustomElements.define('app-root', AppRoot);\n`,
        },
        interactive: true,
    },

    // ── Ecosystem: libraries and stacks real apps are built from ─────────────
    // Installed once into a shared cache (see ensureEcosystem), not into the repo.
    {
        name: 'alpine',
        ecosystem: true,
        deps: { alpinejs: '3.14.9' },
        hmrFile: 'src/message.ts',
        files: {
            'index.html': `<!DOCTYPE html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><title>lunx matrix</title></head>\n  <body>\n    <div id="root" x-data="state"><h1 class="marker" x-text="msg"></h1><button id="inc" @click="n++" x-text="n"></button></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`,
            'src/index.css': SHARED_CSS,
            'src/message.ts': `export const message = '${MARKER_BEFORE}';\n`,
            'src/main.ts': `import './index.css';\nimport Alpine from 'alpinejs';\nimport { message } from './message';\nAlpine.data('state', () => ({ msg: message, n: 0 }));\nAlpine.start();\n`,
        },
        interactive: true,
    },
    {
        name: 'mithril',
        ecosystem: true,
        deps: { mithril: '2.2.15' },
        hmrFile: 'src/app.ts',
        files: {
            'index.html': html('src/main.ts'),
            'src/index.css': SHARED_CSS,
            'src/app.ts': `import m from 'mithril';\nlet n = 0;\nexport const App = { view: () => [m('h1.marker', '${MARKER_BEFORE}'), m('button#inc', { onclick: () => n++ }, n)] };\n`,
            'src/main.ts': `import './index.css';\nimport m from 'mithril';\nimport { App } from './app';\nm.mount(document.getElementById('root')!, App);\n`,
        },
        interactive: true,
    },
    {
        name: 'jquery',
        ecosystem: true,
        deps: { jquery: '3.7.1' },
        hmrFile: 'src/main.ts',
        files: {
            'index.html': html('src/main.ts'),
            'src/index.css': SHARED_CSS,
            'src/main.ts': `import './index.css';\nimport $ from 'jquery';\n$('#root').html('<h1 class="marker">${MARKER_BEFORE}</h1>');\n`,
        },
    },
    {
        name: 'three',
        ecosystem: true,
        deps: { three: '0.182.0' },
        hmrFile: 'src/main.ts',
        files: {
            'index.html': html('src/main.ts'),
            'src/index.css': SHARED_CSS,
            'src/main.ts': `import './index.css';\nimport { Vector3, MathUtils } from 'three';\nconst v = new Vector3(1, 2, 2);\ndocument.getElementById('root')!.innerHTML = '<h1 class="marker">${MARKER_BEFORE}</h1><p>' + v.length() + ' ' + MathUtils.clamp(5, 0, 1) + '</p>';\n`,
        },
    },
    {
        name: 'react-tailwind',
        ecosystem: true,
        deps: { react: '19.2.3', 'react-dom': '19.2.3', tailwindcss: '4.1.18', '@tailwindcss/postcss': '4.1.18', postcss: '8.5.6' },
        hmrFile: 'src/App.tsx',
        files: {
            'index.html': html('src/main.tsx'),
            'postcss.config.mjs': `export default { plugins: { '@tailwindcss/postcss': { base: import.meta.dirname } } };\n`,
            'src/index.css': `@import "tailwindcss";\n`,
            'src/main.tsx': `import './index.css';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
            'src/App.tsx': `export default function App() {\n  return <h1 className="marker text-[rgb(0,187,119)] font-bold">${MARKER_BEFORE}</h1>;\n}\n`,
        },
    },
    {
        name: 'react-styled',
        ecosystem: true,
        deps: { react: '19.2.3', 'react-dom': '19.2.3', 'styled-components': '6.1.19' },
        hmrFile: 'src/App.tsx',
        files: {
            'index.html': html('src/main.tsx'),
            'src/main.tsx': `import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
            'src/App.tsx': `import styled from 'styled-components';\nconst Title = styled.h1\`\n  color: rgb(0, 187, 119);\n  font-weight: 700;\n\`;\nexport default function App() {\n  return <Title className="marker">${MARKER_BEFORE}</Title>;\n}\n`,
        },
    },
    {
        name: 'react-router',
        ecosystem: true,
        deps: { react: '19.2.3', 'react-dom': '19.2.3', 'react-router': '7.9.4' },
        hmrFile: 'src/Home.tsx',
        files: {
            'index.html': html('src/main.tsx'),
            'src/index.css': SHARED_CSS,
            'src/main.tsx': `import './index.css';\nimport { createRoot } from 'react-dom/client';\nimport { createBrowserRouter, RouterProvider } from 'react-router';\nimport Home from './Home';\nconst router = createBrowserRouter([{ path: '/', element: <Home /> }]);\ncreateRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);\n`,
            'src/Home.tsx': `export default function Home() {\n  return <h1 className="marker">${MARKER_BEFORE}</h1>;\n}\n`,
        },
    },
    {
        name: 'vue-router',
        ecosystem: true,
        deps: { vue: '3.5.26', 'vue-router': '4.6.3' },
        hmrFile: 'src/Home.vue',
        files: {
            'index.html': html('src/main.ts'),
            'src/index.css': SHARED_CSS,
            'src/main.ts': `import './index.css';\nimport { createApp } from 'vue';\nimport { createRouter, createWebHistory } from 'vue-router';\nimport App from './App.vue';\nimport Home from './Home.vue';\nconst router = createRouter({ history: createWebHistory(), routes: [{ path: '/', component: Home }] });\ncreateApp(App).use(router).mount('#root');\n`,
            'src/App.vue': `<template>\n  <RouterView />\n</template>\n`,
            'src/Home.vue': `<script setup lang="ts">\nconst text: string = '${MARKER_BEFORE}';\n</script>\n<template>\n  <h1 class="marker">{{ text }}</h1>\n</template>\n`,
        },
    },
    {
        name: 'sass',
        ecosystem: true,
        deps: { sass: '1.93.2' },
        hmrFile: 'src/main.ts',
        files: {
            'index.html': html('src/main.ts', 'app'),
            'src/_theme.scss': `$brand: rgb(0, 187, 119);\n`,
            'src/styles.scss': `@use 'theme';\n#app {\n  .marker { color: theme.$brand; font-weight: 700; }\n}\n`,
            'src/main.ts': `import './styles.scss';\ndocument.getElementById('app')!.innerHTML = '<h1 class="marker">${MARKER_BEFORE}</h1>';\n`,
        },
    },
    {
        name: 'angular',
        ecosystem: true,
        deps: {
            '@angular/core': '20.3.4', '@angular/common': '20.3.4', '@angular/compiler': '20.3.4',
            '@angular/platform-browser': '20.3.4', rxjs: '7.8.2', tslib: '2.8.1', typescript: '5.9.3',
        },
        hmrFile: 'src/app.component.ts',
        config: `import { defineConfig } from 'lunx';\nexport default defineConfig({ framework: 'angular' });\n`,
        files: {
            'index.html': `<!DOCTYPE html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><title>lunx matrix</title></head>\n  <body>\n    <div id="root"><app-root></app-root></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`,
            'src/index.css': SHARED_CSS,
            'src/main.ts': `import './index.css';\nimport '@angular/compiler';\nimport { provideZonelessChangeDetection } from '@angular/core';\nimport { bootstrapApplication } from '@angular/platform-browser';\nimport { AppComponent } from './app.component';\nbootstrapApplication(AppComponent, { providers: [provideZonelessChangeDetection()] });\n`,
            'src/app.component.ts': `import { Component, signal } from '@angular/core';\n@Component({\n  selector: 'app-root',\n  template: '<h1 class="marker">{{ text }}</h1><button id="inc" (click)="n.set(n() + 1)">{{ n() }}</button>',\n})\nexport class AppComponent {\n  text = '${MARKER_BEFORE}';\n  n = signal(0);\n}\n`,
            'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ES2022', experimentalDecorators: true, useDefineForClassFields: false, strict: false } }, null, 2),
        },
        interactive: true,
    },
    {
        name: 'qwik',
        ecosystem: true,
        deps: { '@builder.io/qwik': '1.17.1' },
        hmrFile: 'src/app.tsx',
        // Known issue: in client-only render() mode the $-handlers render without
        // listeners, so clicks do nothing. Rendering, HMR and build are covered.
        knownIssue: 'client-side render(): event handlers not attached',
        config: `import { defineConfig } from 'lunx';\nexport default defineConfig({ framework: 'qwik' });\n`,
        files: {
            'index.html': html('src/main.tsx'),
            'src/index.css': SHARED_CSS,
            'src/main.tsx': `import './index.css';\nimport '@builder.io/qwik/qwikloader.js';\nimport { render } from '@builder.io/qwik';\nimport { App } from './app';\nrender(document.getElementById('root')!, <App />);\n`,
            'src/app.tsx': `import { component$, useSignal } from '@builder.io/qwik';\nexport const App = component$(() => {\n  const n = useSignal(0);\n  return <><h1 class="marker">${MARKER_BEFORE}</h1><button id="inc" onClick$={() => n.value++}>{n.value}</button></>;\n});\n`,
            'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: '@builder.io/qwik', target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler' } }, null, 2),
        },
    },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/** One shared install of every ecosystem package, reused across runs. */
async function ensureEcosystem(frameworks) {
    const deps = {};
    for (const f of frameworks) if (f.ecosystem) Object.assign(deps, f.deps);
    if (Object.keys(deps).length === 0) return null;
    const key = Object.entries(deps).sort().map(([k, v]) => `${k}@${v}`).join(',');
    const dir = path.join(os.tmpdir(), 'lunx-matrix-ecosystem');
    const stamp = path.join(dir, '.installed');
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === key) return dir;
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'lunx-matrix-ecosystem', private: true, dependencies: deps }, null, 2));
    console.log(`installing ecosystem packages (${Object.keys(deps).length})...`);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = await new Promise((resolve) => {
        const child = spawn(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
        child.on('exit', resolve);
    });
    if (result !== 0) throw new Error('ecosystem install failed');
    await fsp.writeFile(stamp, key);
    return dir;
}

let ecosystemDir = null;

async function scaffold(framework, root) {
    await fsp.mkdir(path.join(root, 'src'), { recursive: true });
    for (const [rel, content] of Object.entries(framework.files)) {
        const target = path.join(root, rel);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, content);
    }
    if (framework.config) await fsp.writeFile(path.join(root, 'lunx.config.ts'), framework.config);
    await fsp.writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: `lunx-matrix-${framework.name}`, private: true, type: 'module', dependencies: framework.deps }, null, 2),
    );
    // Link the repo's node_modules so the app resolves its framework without
    // a per-app install.
    const link = path.join(root, 'node_modules');
    if (!fs.existsSync(link)) {
        try {
            const source = framework.ecosystem ? path.join(ecosystemDir, 'node_modules') : path.join(REPO, 'node_modules');
            fs.symlinkSync(source, link, 'junction');
        } catch {
            // Fall back to a directory junction failure being non-fatal; the
            // dev server also resolves from the repo root.
        }
    }
}

function startProcess(commandArgs, cwd, readyPattern, timeoutMs = 90_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, commandArgs, {
            cwd,
            env: { ...process.env, NO_COLOR: '1', LUNX_QUIET: '' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`timeout waiting for "${readyPattern}"\n${output.slice(-1500)}`));
        }, timeoutMs);

        const onChunk = (chunk) => {
            output += chunk.toString();
            if (output.includes(readyPattern)) {
                clearTimeout(timer);
                resolve({ child, output: () => output });
            }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('exit', (code) => {
            if (!output.includes(readyPattern)) {
                clearTimeout(timer);
                reject(new Error(`process exited (${code}) before ready\n${output.slice(-1500)}`));
            }
        });
    });
}

/** Static file server for the production `dist/`, so `build` output is checked too. */
function serveDist(dir, port) {
    const types = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
    };
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        let file = path.join(dir, url === '/' ? 'index.html' : url);
        if (!file.startsWith(dir)) {
            res.writeHead(403).end();
            return;
        }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dir, 'index.html');
        if (!fs.existsSync(file)) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function run(commandArgs, cwd, timeoutMs = 180_000) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, commandArgs, {
            cwd,
            env: { ...process.env, NO_COLOR: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const timer = setTimeout(() => {
            child.kill();
            resolve({ code: -1, output: `${output}\n[timeout]` });
        }, timeoutMs);
        child.stdout.on('data', (c) => (output += c));
        child.stderr.on('data', (c) => (output += c));
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, output });
        });
    });
}

/** Click #inc twice (shadow DOM included) and expect it to read 2. */
async function clickCounter(page) {
    try {
        const button = page.locator('#inc').first();
        await button.click({ timeout: 5000 });
        await button.click({ timeout: 5000 });
        await page.waitForFunction(() => {
            const el = document.querySelector('#inc') ?? document.querySelector('app-root')?.shadowRoot?.querySelector('#inc');
            return el?.textContent?.trim() === '2';
        }, null, { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

const tsxLoader = process.env.LUNX_CLI ? [] : ['--import', 'tsx'];

// ── The matrix ──────────────────────────────────────────────────────────────

const selected = only ? FRAMEWORKS.filter((f) => only.includes(f.name)) : FRAMEWORKS;
const results = [];
// CHROMIUM_PATH lets CI / sandboxes reuse a pre-installed browser instead of
// matching Playwright's pinned download.
ecosystemDir = await ensureEcosystem(selected);
const browser = await chromium.launch({ headless: !headed, executablePath: process.env.CHROMIUM_PATH || undefined });

for (const framework of selected) {
    const result = {
        framework: framework.name,
        dev: 'skip',
        css: 'skip',
        consoleClean: 'skip',
        interactive: 'skip',
        hmr: 'skip',
        build: 'skip',
        preview: 'skip',
        bootMs: null,
        paintMs: null,
        buildMs: null,
        notes: [],
    };
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `lunx-matrix-${framework.name}-`));
    let devProcess = null;
    let distServer = null;
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message.slice(0, 200)}`));

    try {
        await scaffold(framework, root);
        const port = await freePort();

        // 1. dev server boots
        const bootStart = Date.now();
        devProcess = await startProcess([...tsxLoader, CLI, 'dev', '--root', root, '--port', String(port)], REPO, 'ready in');
        result.bootMs = Date.now() - bootStart;

        // 2. the app mounts and renders
        const paintStart = Date.now();
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForFunction(
            (text) => document.body.innerText.includes(text) || Boolean(document.querySelector('app-root')?.shadowRoot?.textContent?.includes(text)),
            MARKER_BEFORE,
            { timeout: 30_000 },
        );
        result.paintMs = Date.now() - paintStart;
        result.dev = 'pass';

        // 3. CSS was processed and applied
        const colour = await page.evaluate(() => {
            const el = document.querySelector('.marker') ?? document.querySelector('app-root')?.shadowRoot?.querySelector('h1');
            return el ? getComputedStyle(el).color : null;
        });
        result.css = colour === 'rgb(0, 187, 119)' ? 'pass' : 'fail';
        if (result.css === 'fail') result.notes.push(`marker colour was ${colour}`);

        // 4. no console errors during a clean load
        result.consoleClean = consoleErrors.length === 0 ? 'pass' : 'fail';
        if (consoleErrors.length > 0) result.notes.push(`console: ${consoleErrors[0]}`);

        // 4b. The UI reacts: click a counter twice and expect "2". Rendering
        // alone can pass with a compiler that is not wired up for reactivity.
        if (framework.knownIssue) result.notes.push(`known issue: ${framework.knownIssue}`);
        if (framework.interactive) {
            result.interactive = (await clickCounter(page)) ? 'pass' : 'fail';
            if (result.interactive === 'fail') result.notes.push('counter did not update after clicks');
        }

        // 5. HMR: edit a source file, expect the browser to show the new text
        const hmrPath = path.join(root, framework.hmrFile);
        const before = await fsp.readFile(hmrPath, 'utf8');
        await fsp.writeFile(hmrPath, before.replace(MARKER_BEFORE, MARKER_AFTER));
        try {
            await page.waitForFunction(
                (text) => document.body.innerText.includes(text) || Boolean(document.querySelector('app-root')?.shadowRoot?.textContent?.includes(text)),
                MARKER_AFTER,
                { timeout: 20_000 },
            );
            result.hmr = 'pass';
        } catch {
            result.hmr = 'fail';
            result.notes.push('edit did not reach the browser within 20s');
        }

        devProcess.child.kill();
        devProcess = null;

        // 6. production build
        const buildStart = Date.now();
        const build = await run([...tsxLoader, CLI, 'build', '--root', root], REPO);
        result.buildMs = Date.now() - buildStart;
        const distDir = path.join(root, 'dist');
        const built = build.code === 0 && fs.existsSync(path.join(distDir, 'index.html'));
        result.build = built ? 'pass' : 'fail';
        if (!built) result.notes.push(`build exit ${build.code}: ${build.output.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`);

        // 7. the built output renders the same thing
        if (built) {
            const previewPort = await freePort();
            distServer = await serveDist(distDir, previewPort);
            const previewErrors = [];
            const previewPage = await browser.newPage();
            previewPage.on('pageerror', (err) => previewErrors.push(err.message.slice(0, 160)));
            try {
                await previewPage.goto(`http://127.0.0.1:${previewPort}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
                await previewPage.waitForFunction(
                    (text) => document.body.innerText.includes(text) || Boolean(document.querySelector('app-root')?.shadowRoot?.textContent?.includes(text)),
                    MARKER_AFTER,
                    { timeout: 20_000 },
                );
                // The production CSS pipeline is separate from dev's, so check it too.
                const previewColour = await previewPage.evaluate(() => {
                    const el = document.querySelector('.marker') ?? document.querySelector('app-root')?.shadowRoot?.querySelector('h1');
                    return el ? getComputedStyle(el).color : null;
                });
                if (previewColour !== 'rgb(0, 187, 119)') previewErrors.push(`production marker colour was ${previewColour}`);
                if (framework.interactive && !(await clickCounter(previewPage))) previewErrors.push('production counter did not update after clicks');
                result.preview = previewErrors.length === 0 ? 'pass' : 'fail';
                if (previewErrors.length > 0) result.notes.push(`preview: ${previewErrors[0]}`);
            } catch {
                result.preview = 'fail';
                result.notes.push('built output did not render the marker');
            }
            await previewPage.close();
        }
    } catch (err) {
        result.notes.push(String(err.message).split('\n')[0].slice(0, 220));
        if (result.dev === 'skip') result.dev = 'fail';
        for (const e of consoleErrors.slice(0, 2)) result.notes.push(`console: ${e}`);
        try {
            const body = await page.evaluate(() => document.body.innerHTML.slice(0, 220));
            result.notes.push(`body: ${body.replace(/\s+/g, ' ')}`);
        } catch {
            /* page may already be gone */
        }
    } finally {
        devProcess?.child.kill();
        distServer?.close();
        await page.close();
        if (!keepTemp) await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }

    results.push(result);
    const line = [
        result.framework.padEnd(11),
        `dev:${result.dev}`.padEnd(10),
        `css:${result.css}`.padEnd(10),
        `console:${result.consoleClean}`.padEnd(14),
        `ui:${result.interactive}`.padEnd(8),
        `hmr:${result.hmr}`.padEnd(10),
        `build:${result.build}`.padEnd(12),
        `preview:${result.preview}`.padEnd(14),
        result.bootMs !== null ? `boot ${result.bootMs}ms` : '',
    ].join(' ');
    console.log(line);
    for (const note of result.notes) console.log(`            ↳ ${note}`);
}

await browser.close();

// ── Report ──────────────────────────────────────────────────────────────────

const checks = ['dev', 'css', 'consoleClean', 'interactive', 'hmr', 'build', 'preview'];
const total = results.length * checks.length;
const passed = results.reduce((n, r) => n + checks.filter((c) => r[c] === 'pass').length, 0);
const failed = results.reduce((n, r) => n + checks.filter((c) => r[c] === 'fail').length, 0);

console.log(`\n${passed}/${total} checks passed (${failed} failed, ${total - passed - failed} skipped)`);

const reportPath = path.join(REPO, 'reports', 'BROWSER_MATRIX.json');
await fsp.mkdir(path.dirname(reportPath), { recursive: true });
await fsp.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`report: ${path.relative(REPO, reportPath)}`);

process.exit(failed === 0 ? 0 : 1);
