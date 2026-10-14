/**
 * Popular Vite plugins in a lunx app (React, not a framework project), the
 * way a user gets them: installed from npm next to the packed lunx-dev, each
 * scenario built (`lunx build`), served (`lunx preview`) and run on the dev
 * server (`lunx dev`), and a browser checks the page each one produces.
 *
 * Run: node scripts/vite-plugins-matrix.mjs [--only=pwa,tailwind] [--tarball=lunx-dev-x.tgz] [--keep]
 *      CHROMIUM_PATH=/path/to/chromium for a system browser.
 * Writes reports/VITE_PLUGINS_MATRIX.json.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { chromium } from 'playwright';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const only = flag('only')?.split(',');
const keep = process.argv.includes('--keep');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-vite-plugins-'));

/** A grey square PNG, size × size. */
function png(size) {
    const crc = (buf) => {
        let c = ~0;
        for (const byte of buf) {
            c ^= byte;
            for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        }
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
    header[8] = 8; // bit depth
    header[9] = 0; // greyscale
    const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size, 128)])));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(16);
// A WebAssembly module exporting add(a, b).
const WASM = Buffer.from('0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b', 'hex');

/**
 * Not here: @vitejs/plugin-legacy, whose legacy chunks are a second build in
 * SystemJS format, which Rolldown does not write.
 *
 * name, packages, vite.config imports and plugin calls, project files, and
 * what the page must show: `{ sel, text | tag | style: [prop, value] }`,
 * `{ fetch: url, contains }`, `{ sw: true, offline: sel }` (preview only: an active service worker, and `sel` rendered with the network off); `dist` / `root`:
 * files the build must write.
 */
const SCENARIOS = [
    {
        name: 'pwa',
        packages: ['vite-plugin-pwa'],
        imports: [`import { VitePWA } from 'vite-plugin-pwa';`],
        plugins: [`VitePWA({ registerType: 'autoUpdate', manifest: { name: 'Matrix', short_name: 'M', icons: [] } })`],
        main: `import { registerSW } from 'virtual:pwa-register';\nregisterSW({ immediate: true });`,
        app: `<p id="check">pwa ok</p>`,
        expect: [{ sel: '#check', text: 'pwa ok' }, { sw: true, offline: '#check' }],
        dist: ['sw.js', 'manifest.webmanifest'],
        html: /rel="manifest"/,
    },
    {
        name: 'tailwind',
        packages: ['tailwindcss', '@tailwindcss/vite'],
        imports: [`import tailwindcss from '@tailwindcss/vite';`],
        plugins: ['tailwindcss()'],
        css: '@import "tailwindcss";\n',
        app: `<h1 id="check" className="font-bold text-red-500">tailwind ok</h1>`,
        expect: [{ sel: '#check', style: ['fontWeight', '700'] }],
    },
    {
        name: 'unocss',
        packages: ['unocss'],
        imports: [`import UnoCSS from 'unocss/vite';`],
        plugins: ['UnoCSS()'],
        files: { 'uno.config.ts': `import { defineConfig, presetWind3 } from 'unocss';\nexport default defineConfig({ presets: [presetWind3()] });\n` },
        main: `import 'virtual:uno.css';`,
        app: `<h1 id="check" className="font-bold">unocss ok</h1>`,
        expect: [{ sel: '#check', style: ['fontWeight', '700'] }],
    },
    {
        name: 'svgr',
        packages: ['vite-plugin-svgr'],
        imports: [`import svgr from 'vite-plugin-svgr';`],
        plugins: ['svgr()'],
        files: { 'src/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>' },
        appImports: `import Logo from './logo.svg?react';`,
        app: `<Logo id="check" />`,
        expect: [{ sel: '#check', tag: 'svg' }],
    },
    {
        name: 'tsconfig-paths',
        packages: ['vite-tsconfig-paths'],
        imports: [`import tsconfigPaths from 'vite-tsconfig-paths';`],
        plugins: ['tsconfigPaths()'],
        files: { 'src/lib/greet.ts': `export const greet = (what: string) => \`\${what} ok\`;\n` },
        appImports: `import { greet } from '@/lib/greet';`,
        app: `<p id="check">{greet('paths')}</p>`,
        expect: [{ sel: '#check', text: 'paths ok' }],
    },
    {
        name: 'auto-import',
        packages: ['unplugin-auto-import'],
        imports: [`import AutoImport from 'unplugin-auto-import/vite';`],
        plugins: [`AutoImport({ imports: ['react'], dts: 'src/auto-imports.d.ts' })`],
        appBody: `const [text] = useState('auto-import ok');`,
        app: `<p id="check">{text}</p>`,
        expect: [{ sel: '#check', text: 'auto-import ok' }],
    },
    {
        name: 'icons',
        packages: ['unplugin-icons', '@iconify-json/mdi'],
        imports: [`import Icons from 'unplugin-icons/vite';`],
        plugins: [`Icons({ compiler: 'jsx', jsx: 'react' })`],
        appImports: `import IconHome from '~icons/mdi/home';`,
        app: `<IconHome id="check" />`,
        expect: [{ sel: '#check', tag: 'svg' }],
    },
    {
        name: 'html',
        packages: ['vite-plugin-html'],
        imports: [`import { createHtmlPlugin } from 'vite-plugin-html';`],
        plugins: [`createHtmlPlugin({ inject: { data: { title: 'ejs ok' } } })`],
        title: '<%- title %>',
        app: `<p id="check">html</p>`,
        expect: [{ title: 'ejs ok' }],
    },
    {
        name: 'static-copy',
        packages: ['vite-plugin-static-copy'],
        imports: [`import { viteStaticCopy } from 'vite-plugin-static-copy';`],
        plugins: [`viteStaticCopy({ targets: [{ src: 'extra/robots.txt', dest: '.' }] })`],
        files: { 'extra/robots.txt': 'User-agent: *\n' },
        app: `<p id="check">copy</p>`,
        expect: [{ fetch: '/extra/robots.txt', contains: 'User-agent' }],
        dist: ['extra/robots.txt'],
    },
    {
        name: 'visualizer',
        packages: ['rollup-plugin-visualizer'],
        imports: [`import { visualizer } from 'rollup-plugin-visualizer';`],
        plugins: [`visualizer({ filename: 'stats.html' })`],
        app: `<p id="check">visualizer ok</p>`,
        expect: [{ sel: '#check', text: 'visualizer ok' }],
        root: ['stats.html'],
    },
    {
        name: 'mdx',
        packages: ['@mdx-js/rollup'],
        imports: [`import mdx from '@mdx-js/rollup';`],
        plugins: [`{ enforce: 'pre', ...mdx() }`],
        files: { 'src/doc.mdx': '# mdx ok\n' },
        appImports: `// @ts-ignore\nimport Doc from './doc.mdx';`,
        app: `<div id="check"><Doc /></div>`,
        expect: [{ sel: '#check h1', text: 'mdx ok' }],
    },
    {
        name: 'glsl',
        packages: ['vite-plugin-glsl'],
        imports: [`import glsl from 'vite-plugin-glsl';`],
        plugins: ['glsl()'],
        files: { 'src/shader.frag': 'void main() { gl_FragColor = vec4(1.0); }\n' },
        appImports: `// @ts-ignore\nimport shader from './shader.frag';`,
        app: `<p id="check">{shader.includes('gl_FragColor') ? 'glsl ok' : 'glsl missing'}</p>`,
        expect: [{ sel: '#check', text: 'glsl ok' }],
    },
    {
        name: 'imagetools',
        packages: ['vite-imagetools'],
        imports: [`import { imagetools } from 'vite-imagetools';`],
        plugins: ['imagetools()'],
        files: { 'src/pixel.png': PNG },
        appImports: `// @ts-ignore\nimport pixel from './pixel.png?w=4&format=webp';`,
        app: `<img id="check" src={pixel} />`,
        expect: [{ sel: '#check', image: 4 }],
    },
    {
        name: 'wasm',
        // Without vite-plugin-top-level-await: browsers run top-level await, and it needs esbuild, which Vite 8 no longer installs.
        packages: ['vite-plugin-wasm'],
        imports: [`import wasm from 'vite-plugin-wasm';`],
        plugins: ['wasm()'],
        files: { 'src/add.wasm': WASM },
        appImports: `// @ts-ignore\nimport { add } from './add.wasm';`,
        app: `<p id="check">wasm {add(2, 3)}</p>`,
        expect: [{ sel: '#check', text: 'wasm 5' }],
    },
    {
        name: 'node-polyfills',
        packages: ['vite-plugin-node-polyfills'],
        imports: [`import { nodePolyfills } from 'vite-plugin-node-polyfills';`],
        plugins: ['nodePolyfills()'],
        appImports: `import { Buffer } from 'buffer';`,
        app: `<p id="check">{Buffer.from('cG9seWZpbGwgb2s=', 'base64').toString()}</p>`,
        expect: [{ sel: '#check', text: 'polyfill ok' }],
    },
    {
        name: 'checker',
        packages: ['vite-plugin-checker'],
        imports: [`import checker from 'vite-plugin-checker';`],
        plugins: ['checker({ typescript: true })'],
        app: `<p id="check">checker ok</p>`,
        expect: [{ sel: '#check', text: 'checker ok' }],
    },
    {
        name: 'inspect',
        packages: ['vite-plugin-inspect'],
        imports: [`import Inspect from 'vite-plugin-inspect';`],
        plugins: ['Inspect()'],
        app: `<p id="check">inspect ok</p>`,
        expect: [{ sel: '#check', text: 'inspect ok' }, { fetch: '/__inspect/', contains: '<', dev: true }],
    },
    // Built into lunx: the same features with no plugin installed.
    {
        name: 'builtin-svg',
        packages: [],
        imports: [],
        plugins: [],
        files: { 'src/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" stroke-width="2"><circle cx="5" cy="5" r="4"/></svg>' },
        appImports: `// @ts-ignore\nimport Logo from './logo.svg?react';`,
        app: `<Logo id="check" className="logo" />`,
        expect: [{ sel: '#check.logo', tag: 'svg' }, { sel: '#check circle', tag: 'circle' }],
    },
    {
        name: 'builtin-wasm-init',
        packages: [],
        imports: [],
        plugins: [],
        files: { 'src/add.wasm': WASM },
        appImports: `import { useEffect, useState } from 'react';\n// @ts-ignore\nimport init from './add.wasm?init';`,
        appBody: `const [sum, setSum] = useState(0);\n  useEffect(() => { init().then((instance: any) => setSum(instance.exports.add(2, 3))); }, []);`,
        app: `{sum ? <p id="check">wasm {sum}</p> : null}`,
        expect: [{ sel: '#check', text: 'wasm 5' }],
    },
    {
        name: 'builtin-pwa',
        packages: [],
        imports: [],
        plugins: [],
        files: { 'lunx.config.ts': `export default { pwa: { manifest: { name: 'Matrix', short_name: 'M', icons: [] } } };\n` },
        app: `<p id="check">pwa ok</p>`,
        expect: [{ sel: '#check', text: 'pwa ok' }, { sw: true, offline: '#check' }],
        dist: ['sw.js', 'manifest.webmanifest', 'registerSW.js'],
        html: /rel="manifest"/,
    },
    {
        name: 'builtin-typecheck',
        packages: [],
        imports: [],
        plugins: [],
        files: { 'lunx.config.ts': `export default { server: { typecheck: true } };\n` },
        appBody: `// A type error: the page still runs, and in dev the overlay lists it.\n  const label: number = 'typed';`,
        app: `<p id="check">{label}</p>`,
        expect: [{ sel: '#check', text: 'typed' }, { sel: 'lunx-error-overlay .error-item .message', text: "TS2322: Type 'string' is not assignable to type 'number'.", dev: true }],
    },
    {
        name: 'builtin-html-env',
        packages: [],
        imports: [],
        plugins: [],
        title: '%VITE_APP_TITLE%',
        files: { '.env': 'VITE_APP_TITLE=env ok\n' },
        app: `<p id="check">html env</p>`,
        expect: [{ title: 'env ok' }],
        html: /<title>env ok<\/title>/,
    },
];

const BASE_PACKAGES = ['react', 'react-dom', '@types/react', '@types/react-dom', 'typescript', '@vitejs/plugin-react'];

function log(...args) {
    console.log(...args);
}

function run(cmd, args, cwd, timeoutMs, env = {}) {
    const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return { code: res.status ?? (res.signal ? 1 : 0), output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
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

function serve(cwd, command, port) {
    const child = spawn(process.execPath, [path.join(cwd, 'node_modules/lunx-dev/dist/cli.js'), command, '--port', String(port)], {
        cwd,
        detached: true,
        env: { ...process.env, BROWSER: 'none', NO_COLOR: '1' },
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
            await new Promise((r) => setTimeout(r, 1000));
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
            const res = await fetch(url);
            if (res.status < 500) return;
            last = `HTTP ${res.status}`;
        } catch (err) {
            last = err.message;
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`no response from ${url}: ${last}`);
}

function writeProject(dir, s) {
    const files = {
        'package.json': JSON.stringify({ name: `matrix-${s.name}`, private: true, type: 'module' }, null, 2),
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true, baseUrl: '.', paths: { '@/*': ['src/*'] } }, include: ['src'] }),
        'index.html': `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>${s.title ?? 'Matrix'}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
        'vite.config.ts': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n${s.imports.join('\n')}\n\nexport default defineConfig({\n  plugins: [react(), ${s.plugins.join(', ')}],\n});\n`,
        'src/index.css': s.css ?? 'body { margin: 0; }\n',
        'src/main.tsx': `import { createRoot } from 'react-dom/client';\n${s.main ?? ''}\nimport App from './App';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
        'src/App.tsx': `${s.appImports ?? ''}\n\nexport default function App() {\n  ${s.appBody ?? ''}\n  return <main>${s.app}</main>;\n}\n`,
        ...s.files,
    };
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
}

async function checkPage(browser, origin, s, mode) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
        if (msg.type() === 'error' && !/favicon|Failed to load resource.*404|ERR_TUNNEL|net::ERR/i.test(msg.text())) errors.push(msg.text());
    });
    try {
        await page.goto(origin + '/', { waitUntil: 'load', timeout: 60_000 });
        for (const want of s.expect) {
            if (want.dev && mode !== 'dev') continue;
            if (want.sw) {
                if (mode !== 'preview') continue;
                const active = await page.evaluate(() => Promise.race([navigator.serviceWorker.ready.then((r) => !!r.active), new Promise((ok) => setTimeout(() => ok(false), 15_000))]));
                if (!active) throw new Error('no active service worker');
                if (want.offline) {
                    // Controlled once claimed; then the app must load with the network gone.
                    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 }).catch(() => {});
                    await page.context().setOffline(true);
                    try {
                        await page.reload({ waitUntil: 'load', timeout: 15_000 });
                        if (!(await page.waitForSelector(want.offline, { timeout: 10_000 }).catch(() => null))) throw new Error(`offline: ${want.offline} not rendered`);
                    } finally {
                        await page.context().setOffline(false);
                    }
                }
                continue;
            }
            if (want.fetch) {
                const res = await fetch(origin + want.fetch);
                const body = await res.text();
                if (res.status !== 200 || !body.includes(want.contains)) throw new Error(`${want.fetch}: HTTP ${res.status}`);
                continue;
            }
            if (want.title) {
                await page.waitForFunction((t) => document.title === t, want.title, { timeout: 15_000 }).catch(() => {});
                const title = await page.title();
                if (title !== want.title) throw new Error(`title is ${JSON.stringify(title)}`);
                continue;
            }
            const el = await page.waitForSelector(want.sel, { timeout: 20_000 }).catch(() => null);
            if (!el) throw new Error(`${want.sel} not rendered${errors.length ? `: ${errors[0]}` : ''}`);
            if (want.text !== undefined) {
                const text = (await el.textContent())?.trim();
                if (text !== want.text) throw new Error(`${want.sel} reads ${JSON.stringify(text)}`);
            }
            if (want.tag) {
                const tag = await el.evaluate((e) => e.tagName.toLowerCase());
                if (tag !== want.tag) throw new Error(`${want.sel} is <${tag}>`);
            }
            if (want.style) {
                const value = await el.evaluate((e, prop) => getComputedStyle(e)[prop], want.style[0]);
                if (value !== want.style[1]) throw new Error(`${want.sel} ${want.style[0]} is ${value}`);
            }
            if (want.image) {
                await page.waitForFunction((sel) => document.querySelector(sel)?.complete, want.sel, { timeout: 10_000 }).catch(() => {});
                const width = await el.evaluate((e) => e.naturalWidth);
                if (width !== want.image) throw new Error(`${want.sel} is ${width}px wide`);
            }
        }
        if (errors.length) throw new Error(`console errors: ${errors.slice(0, 2).join(' | ')}`);
    } finally {
        await page.close();
    }
}

// ── Packages ─────────────────────────────────────────────────────────────────

const scenarios = SCENARIOS.filter((s) => !only || only.includes(s.name));
let tarball = flag('tarball') && path.resolve(flag('tarball'));
if (!tarball) {
    log('packing lunx-dev…');
    const packed = run('npm', ['pack', '--pack-destination', WORK, '--silent'], REPO, 300_000);
    if (packed.code !== 0) throw new Error(`npm pack failed:\n${packed.output}`);
    tarball = path.join(WORK, packed.output.trim().split('\n').pop());
}
const shared = path.join(WORK, 'shared');
fs.mkdirSync(shared);
fs.writeFileSync(path.join(shared, 'package.json'), JSON.stringify({ name: 'matrix-shared', private: true, type: 'module' }));
const packages = [...new Set([...BASE_PACKAGES, ...scenarios.flatMap((s) => s.packages)])];
log(`installing lunx-dev and ${packages.length} packages…`);
const install = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball, ...packages], shared, 900_000);
if (install.code !== 0) throw new Error(`npm install failed:\n${install.output}`);
const versions = Object.fromEntries(packages.map((p) => [p, JSON.parse(fs.readFileSync(path.join(shared, 'node_modules', p, 'package.json'), 'utf8')).version]));

// ── Scenarios ────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const results = [];
for (const s of scenarios) {
    const dir = path.join(WORK, s.name);
    writeProject(dir, s);
    fs.symlinkSync(path.join(shared, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    const result = { name: s.name, plugin: s.packages[0], version: versions[s.packages[0]], build: 'skip', preview: 'skip', dev: 'skip', errors: [] };
    const started = Date.now();
    const fail = (step, err) => {
        result[step] = 'fail';
        result.errors.push(`${step}: ${String(err?.message ?? err).split('\n').slice(0, 6).join(' ')}`);
    };

    const built = run(process.execPath, ['node_modules/lunx-dev/dist/cli.js', 'build'], dir, 300_000, { LUNX_SKIP_SECURITY: '1', NO_COLOR: '1' });
    if (built.code !== 0) fail('build', built.output.split('\n').filter((l) => /error|fail/i.test(l)).slice(0, 4).join(' ') || built.output.slice(-400));
    else {
        const missing = [...(s.dist ?? []).map((f) => path.join('dist', f)), ...(s.root ?? [])].filter((f) => !fs.existsSync(path.join(dir, f)));
        const page = fs.readFileSync(path.join(dir, 'dist/index.html'), 'utf8');
        if (missing.length) fail('build', `missing ${missing.join(', ')}`);
        else if (s.html && !s.html.test(page)) fail('build', `index.html lacks ${s.html}`);
        else result.build = 'pass';
    }

    for (const mode of result.build === 'pass' ? ['preview', 'dev'] : ['dev']) {
        const port = await freePort();
        const server = serve(dir, mode, port);
        try {
            await waitForHttp(`http://localhost:${port}/`, 60_000);
            await checkPage(browser, `http://localhost:${port}`, s, mode);
            result[mode] = 'pass';
        } catch (err) {
            fail(mode, err);
            const tail = server.output.split('\n').filter((l) => /error|fail|warn/i.test(l)).slice(-3).join(' ');
            if (tail) result.errors.push(`${mode} log: ${tail.slice(0, 400)}`);
        } finally {
            await server.stop();
        }
    }
    result.seconds = Math.round((Date.now() - started) / 1000);
    const ok = ['build', 'preview', 'dev'].every((k) => result[k] !== 'fail');
    log(`${ok ? '✓' : '✗'} ${s.name.padEnd(16)} build:${result.build} preview:${result.preview} dev:${result.dev} (${result.seconds}s)${ok ? '' : `\n    ${result.errors.join('\n    ')}`}`);
    results.push(result);
}
await browser.close();

const passed = results.filter((r) => ['build', 'preview', 'dev'].every((k) => r[k] !== 'fail')).length;
const report = { generatedAt: new Date().toISOString(), node: process.version, passed, total: results.length, versions, results };
if (!only) fs.writeFileSync(path.join(REPO, 'reports/VITE_PLUGINS_MATRIX.json'), JSON.stringify(report, null, 2) + '\n');
log(`\n${passed}/${results.length} plugin scenarios passed`);
if (!keep) fs.rmSync(WORK, { recursive: true, force: true });
else log(`kept ${WORK}`);
process.exitCode = passed === results.length ? 0 : 1;
