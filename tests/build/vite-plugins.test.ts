/**
 * Vite plugins in an app (not a framework project) get Vite's lifecycle on
 * lunx's own build and dev server: `apply`, `enforce`, `config`,
 * `configResolved`, virtual modules, `transformIndexHtml`, stylesheet
 * transforms, `writeBundle` / `closeBundle` over the finished app, and
 * `configureServer`. scripts/vite-plugins-matrix.mjs runs the popular
 * plugins themselves (PWA, Tailwind, svgr, icons…) in Chromium.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'dist', 'cli.js');

const CONFIG = `import fs from 'node:fs';
import path from 'node:path';
const report = { order: [], ranServeOnly: false, ranBuildOnly: false };
let resolved;
const write = () => fs.writeFileSync(path.join(resolved.root, 'report.json'), JSON.stringify(report));
export default {
  define: { __FROM_CONFIG__: JSON.stringify('config') },
  plugins: [
    { name: 'post', enforce: 'post', transform(code, id) { if (id.endsWith('main.js')) report.order.push('post'); return null; } },
    { name: 'pre', enforce: 'pre', transform(code, id) { if (id.endsWith('main.js')) report.order.push('pre'); return null; } },
    { name: 'serve-only', apply: 'serve', configResolved() { report.ranServeOnly = true; } },
    { name: 'build-only', apply: 'build', configResolved() { report.ranBuildOnly = true; } },
    {
      name: 'lifecycle',
      config(_config, env) { return { define: { __COMMAND__: JSON.stringify(env.command) } }; },
      configResolved(config) { resolved = config; report.root = config.root; report.outDir = config.build.outDir; report.command = config.command; },
      resolveId(id) { return id === 'virtual:greeting' ? '\\0virtual:greeting' : null; },
      load(id) { if (id === '\\0virtual:greeting') { report.environment = this.environment?.name; return 'import { version } from "react";\\nexport default "hi " + typeof version;'; } return null; },
      configureServer(server) {
        server.middlewares.use('/__plugin', (_req, res) => res.end('from configureServer:' + server.config.command));
        write();
      },
      writeBundle(options, bundle) { report.files = Object.keys(bundle).sort(); report.pageOnDisk = fs.existsSync(path.join(options.dir, 'index.html')); },
      closeBundle() { report.closed = true; write(); },
    },
    { name: 'html-pre', transformIndexHtml: { order: 'pre', handler: (html) => html.replace('%TITLE%', 'From a plugin') } },
    { name: 'html-post', transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'built-by', content: 'plugin' }, injectTo: 'head' }] },
    { name: 'css', enforce: 'pre', transform(code, id) { return id.endsWith('.css') ? code.replace('PLUGIN_COLOR', 'rgb(1, 2, 3)') : null; } },
  ],
};
`;

function project(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-vite-plugins-'));
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const files: Record<string, string> = {
        'package.json': JSON.stringify({ name: 'plugins-app', private: true, type: 'module' }),
        'vite.config.mjs': CONFIG,
        'index.html': '<!DOCTYPE html><html><head><title>%TITLE%</title></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>',
        'src/main.js': 'import greeting from "virtual:greeting";\nimport "./style.css";\ndocument.getElementById("app").textContent = [greeting, __FROM_CONFIG__, __COMMAND__].join(" | ");\n',
        'src/style.css': '#app { color: PLUGIN_COLOR; }\n',
    };
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

const report = (root: string) => JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));

describe('Vite plugins in an app build', () => {
    let root: string;
    let out: ReturnType<typeof spawnSync>;
    beforeAll(() => {
        root = project();
        out = spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', LUNX_SKIP_SECURITY: '1' } });
    }, 120_000);

    it('builds', () => {
        expect([out.status, out.status === 0 ? '' : `${out.stdout}\n${out.stderr}`]).toEqual([0, '']);
    });

    it('runs apply, enforce, config and configResolved as Vite does', () => {
        const r = report(root);
        expect(r.order).toEqual(['pre', 'post']);
        expect([r.ranBuildOnly, r.ranServeOnly]).toEqual([true, false]);
        expect([r.root, r.outDir, r.command]).toEqual([fs.realpathSync(root), 'dist', 'build']);
        const js = fs.readdirSync(path.join(root, 'dist/assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, 'dist/assets', f), 'utf8')).join('\n');
        // The config's define and the one a `config` hook added.
        expect(js).toMatch(/[`"']config[`"']/);
        expect(js).toMatch(/[`"']build[`"']/);
    });

    it('loads virtual modules, whose bare imports resolve from the project', () => {
        const r = report(root);
        expect(r.environment).toBe('client');
        const js = fs.readdirSync(path.join(root, 'dist/assets')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, 'dist/assets', f), 'utf8')).join('\n');
        expect(js).toContain('hi ');
        expect(js).not.toMatch(/from\s*["']react["']/);
    });

    it('transforms the page and the stylesheets', () => {
        const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
        expect(html).toContain('<title>From a plugin</title>');
        expect(html).toContain('<meta name="built-by" content="plugin">');
        const css = fs.readdirSync(path.join(root, 'dist/assets')).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(root, 'dist/assets', f), 'utf8')).join('');
        expect(css).toMatch(/#app\s*\{\s*color:\s*(rgb\(1,\s*2,\s*3\)|#010203)/);
    });

    it('calls writeBundle and closeBundle once the app is on disk', () => {
        const r = report(root);
        expect(r.closed).toBe(true);
        expect(r.pageOnDisk).toBe(true);
        expect(r.files).toEqual(expect.arrayContaining(['index.html', expect.stringMatching(/^assets\/.*\.js$/), expect.stringMatching(/^assets\/.*\.css$/)]));
    });
});

describe('Vite plugins on the app dev server', () => {
    let root: string;
    let dev: ChildProcess;
    const port = 4400 + Math.floor(Math.random() * 500);
    const get = (url: string) => fetch(`http://localhost:${port}${url}`, { headers: { accept: url === '/' ? 'text/html' : '*/*' } }).then(async (r) => ({ status: r.status, body: await r.text() }));

    beforeAll(async () => {
        root = project();
        dev = spawn(process.execPath, [cli, 'dev', '--port', String(port)], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'ignore' });
        for (let i = 0; i < 200; i++) {
            if (await get('/__plugin').then((r) => r.status === 200, () => false)) return;
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('dev server did not start');
    }, 60_000);
    afterAll(() => {
        dev?.kill();
    });

    it('runs configureServer middlewares and apply: serve plugins', async () => {
        expect(await get('/__plugin')).toEqual({ status: 200, body: 'from configureServer:serve' });
        const r = report(root);
        expect([r.ranServeOnly, r.ranBuildOnly, r.command]).toEqual([true, false, 'serve']);
    });

    it('transforms the page', async () => {
        const page = await get('/');
        expect(page.body).toContain('<title>From a plugin</title>');
        expect(page.body).toContain('<meta name="built-by" content="plugin">');
    });

    it('serves virtual modules at /@id/', async () => {
        const main = await get('/src/main.js');
        expect(main.body).toContain('/@id/__x00__virtual:greeting');
        const virtual = await get('/@id/__x00__virtual:greeting');
        expect(virtual.status).toBe(200);
        expect(virtual.body).toContain('"hi "');
        // The bare import inside it goes to lunx's dependency handling like any other.
        expect(virtual.body).not.toMatch(/from\s*["']react["']/);
    });

    it('transforms stylesheets', async () => {
        const css = await get('/src/style.css?import');
        expect(css.body).toMatch(/rgb\(1,\s*2,\s*3\)|#010203/);
    });
});
