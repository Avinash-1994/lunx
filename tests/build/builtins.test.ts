/**
 * Features lunx has built in, which Vite apps get from Vite itself or a plugin:
 * `%ENV%` in HTML, `.wasm?init`, SVG files as components (`?react`,
 * `?component`, in place of vite-plugin-svgr) and a web app manifest with a
 * precaching service worker (`pwa`, in place of vite-plugin-pwa), in
 * `lunx build` and `lunx dev`.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, type ChildProcess } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { startDev, stopProcess, removeDir } from './dev-process.js';
import { replaceHtmlEnv } from '../../src/build/html-env.js';
import { svgComponent, svgRuntimeFor } from '../../src/build/svg-component.js';
import { wasmInitModule } from '../../src/build/wasm-init.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'dist', 'cli.js');

/** (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)) */
const ADD_WASM = Buffer.from('0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b', 'hex');
const SVG = '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="logo" viewBox="0 0 24 24" stroke-width="2" style="fill: red; stroke-linecap: round" data-name="x"><use xlink:href="#a"/><path id="a" d="M0 0h24"/></svg>\n';

function project(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-builtins-'));
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const files: Record<string, string | Buffer> = {
        'package.json': JSON.stringify({ name: 'builtins-app', private: true, type: 'module', dependencies: { react: '*', 'react-dom': '*' } }),
        '.env': 'VITE_APP_TITLE=Built in\n',
        'lunx.config.js': "export default { electron: false, pwa: { manifest: { name: 'Built in', short_name: 'BI', icons: [] }, exclude: ['notes.txt'] } };\n",
        'public/notes.txt': 'not precached',
        'public/robots.txt': 'User-agent: *',
        'index.html': '<!DOCTYPE html><html><head><title>%VITE_APP_TITLE% (%MODE%)</title></head><body data-x="100%25 %UNKNOWN%"><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
        'src/main.jsx': [
            "import { createRoot } from 'react-dom/client';",
            "import Logo from './logo.svg?react';",
            "import init from './add.wasm?init';",
            "init().then((instance) => { document.title += ' ' + instance.exports.add(2, 3); });",
            "createRoot(document.getElementById('root')).render(<Logo width={32} />);",
        ].join('\n'),
        'src/logo.svg': SVG,
        'src/add.wasm': ADD_WASM,
    };
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

describe('built-ins: units', () => {
    it('replaces %ENV% names it knows, and nothing else', () => {
        expect(replaceHtmlEnv('<title>%VITE_X% %MODE%</title> 50%25 %NOPE%', { VITE_X: 'a', MODE: 'production' })).toBe('<title>a production</title> 50%25 %NOPE%');
    });

    it('turns an SVG into a React component with React prop names', () => {
        const code = svgComponent(SVG, 'react');
        expect(code).toContain("from 'react'");
        const attrs = JSON.parse(code.match(/const attrs = (.*);/)![1]!);
        expect(attrs).toEqual({
            xmlns: 'http://www.w3.org/2000/svg', xmlnsXlink: 'http://www.w3.org/1999/xlink', className: 'logo', viewBox: '0 0 24 24',
            strokeWidth: '2', style: { fill: 'red', strokeLinecap: 'round' }, 'data-name': 'x',
        });
        expect(code).toContain('<use xlink:href=\\"#a\\"/>');
        expect(code).not.toContain('<?xml');
    });

    it('keeps DOM attribute names for Preact and Vue, and picks the runtime from the query and framework', () => {
        expect(svgComponent(SVG, 'preact')).toContain('"stroke-width":"2"');
        expect(svgComponent(SVG, 'vue')).toMatch(/innerHTML: /);
        expect(svgRuntimeFor('react', '?react')).toBe('react');
        expect(svgRuntimeFor('preact', '?react')).toBe('preact');
        expect(svgRuntimeFor('vue', '?component')).toBe('vue');
        expect(svgRuntimeFor('svelte', '?component')).toBeNull();
    });

    it('instantiates .wasm?init modules', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-wasm-init-'));
        try {
            const file = path.join(dir, 'add.mjs');
            fs.writeFileSync(file, wasmInitModule(JSON.stringify(`data:application/wasm;base64,${ADD_WASM.toString('base64')}`)));
            const init = (await import(pathToFileURL(file).href)).default;
            expect((await init()).exports.add(2, 3)).toBe(5);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('built-ins: lunx build', () => {
    let root: string;
    beforeAll(() => {
        root = project();
        const r = spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', LUNX_SKIP_SECURITY: '1' } });
        if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    }, 120_000);
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it('replaces %ENV% in the page', () => {
        const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
        expect(html).toContain('<title>Built in (production)</title>');
        expect(html).toContain('100%25 %UNKNOWN%');
    });

    it('writes the manifest and a service worker that precaches the build', () => {
        const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
        expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
        expect(html).toMatch(/<script src="\/registerSW\.js"[^>]*defer><\/script>/);
        expect(JSON.parse(fs.readFileSync(path.join(root, 'dist/manifest.webmanifest'), 'utf8'))).toMatchObject({ name: 'Built in', short_name: 'BI', start_url: '/', display: 'standalone' });
        expect(fs.readFileSync(path.join(root, 'dist/registerSW.js'), 'utf8')).toContain('navigator.serviceWorker.register("/sw.js"');
        const sw = fs.readFileSync(path.join(root, 'dist/sw.js'), 'utf8');
        const precache: string[] = JSON.parse(sw.match(/const PRECACHE = (.*);/)![1]!);
        expect(precache).toEqual(expect.arrayContaining(['./index.html', './manifest.webmanifest', './registerSW.js', './robots.txt']));
        expect(precache.some((f) => /^\.\/assets\/main\.[\w-]+\.js$/.test(f))).toBe(true);
        expect(precache.some((f) => f.endsWith('.wasm'))).toBe(true);
        expect(precache.filter((f) => /\.(map|gz|br)$|lunx-|notes\.txt|sw\.js/.test(f))).toEqual([]);
        expect(sw).toContain('const FALLBACK = "./index.html"');
    });

    it('bundles the SVG component and the wasm loader, and emits the wasm', () => {
        const assets = fs.readdirSync(path.join(root, 'dist/assets'));
        const js = assets.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, 'dist/assets', f), 'utf8')).join('\n');
        expect(js).toContain('dangerouslySetInnerHTML');
        expect(js).toContain('strokeLinecap');
        expect(js).toMatch(/instantiate/);
        const wasm = assets.find((f) => f.endsWith('.wasm'));
        expect(wasm).toBeDefined();
        expect(js).toContain(wasm);
    });
});

describe('built-ins: lunx dev', () => {
    let root: string;
    let dev: ChildProcess;
    let port: number;
    const get = (url: string) => fetch(`http://localhost:${port}${url}`, { headers: { accept: url === '/' ? 'text/html' : '*/*' } }).then(async (r) => ({ status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() }));

    beforeAll(async () => {
        root = project();
        ({ child: dev, port } = await startDev(cli, root));
    }, 60_000);
    afterAll(async () => {
        await stopProcess(dev);
        removeDir(root);
    });

    it('replaces %ENV% in the page', async () => {
        expect((await get('/')).body).toContain('<title>Built in (development)</title>');
    });

    it('marks the imports and serves the SVG as a component', async () => {
        const main = await get('/src/main.jsx');
        expect(main.body).toContain('./logo.svg?react&import');
        const svg = await get('/src/logo.svg?react&import');
        expect(svg.type).toContain('javascript');
        expect(svg.body).toContain('forwardRef');
        expect(svg.body).not.toMatch(/from\s*["']react["']/); // rewritten to lunx's dependency URL
    });

    it('serves .wasm?init as a loader, and the wasm itself as application/wasm', async () => {
        const loader = await get('/src/add.wasm?init&import');
        expect(loader.body).toContain('WebAssembly.instantiate');
        expect(loader.body).toContain('"/src/add.wasm"');
        expect((await get('/src/add.wasm')).type).toBe('application/wasm');
    });
});
