/**
 * Options production projects reach for (reports/BUILD_TOOL_LANDSCAPE.md §6):
 * page options, CDN URLs, file name templates, externals, drop, ssrManifest,
 * prefetch, public/ and outDir handling, and the dev server's host and CORS rules.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { addNonce, applyHtmlOptions } from '../../src/build/html-options.js';
import { corsOrigin, hostAllowed } from '../../src/dev/access.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'dist', 'cli.js');
const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function build(config: string, files: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-options-'));
    dirs.push(dir);
    const all: Record<string, string> = {
        'package.json': '{"type":"module"}',
        'index.html': '<!DOCTYPE html><html><head><title>x</title></head><body><script type="module" src="/src/main.js"></script></body></html>',
        'lunx.config.js': config,
        'public/robots.txt': 'hi',
        ...files,
    };
    for (const [rel, content] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    const r = spawnSync(process.execPath, [cli, 'build'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', LUNX_SKIP_SECURITY: '1', LUNX_BUILD_CACHE: '0' } });
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const dist = path.join(dir, 'dist');
    const list = (fs.readdirSync(dist, { recursive: true }) as string[]).map((f) => f.split(path.sep).join('/')).filter((f) => !/\.(gz|br)$/.test(f));
    return { dist, list, read: (f: string) => fs.readFileSync(path.join(dist, f), 'utf8'), log: r.stdout + r.stderr };
}

describe('build options', () => {
    const out = build(`export default {
  html: { title: 'T', meta: { description: 'd' }, cspNonce: 'n0' },
  build: { assetPrefix: 'https://cdn.test/app/', prefetch: true, ssrManifest: true, drop: ['console'], external: ['ext-lib'],
    entryFileNames: 'js/[name]-[hash].js', chunkFileNames: 'js/c-[hash].js', assetFileNames: 'static/[name]-[hash][extname]',
    copyPublicDir: false, chunkSizeWarningLimit: 0.00001 },
};`, {
        'src/main.js': "import './a.css';\nimport { x } from 'ext-lib';\nconsole.log('gone');\ndocument.title = String(x);\nimport('./lazy.js').then((m) => m.run());\n",
        'src/a.css': '.a { color: red; }\n',
        'src/lazy.js': 'export const run = () => document.body.dataset.x;\n',
    });

    it('applies file name templates and leaves public/ out', () => {
        expect(out.list.some((f) => /^js\/main-.+\.js$/.test(f))).toBe(true);
        expect(out.list.some((f) => /^js\/c-.+\.js$/.test(f))).toBe(true);
        expect(out.list.some((f) => /^static\/style-.+\.css$/.test(f))).toBe(true);
        expect(out.list).not.toContain('robots.txt');
    });

    it('loads files from assetPrefix, prefetches lazy chunks, adds the page options and nonce', () => {
        const html = out.read('index.html');
        expect(html).toMatch(/<script type="module" src="https:\/\/cdn\.test\/app\/js\/main-[^"]+\.js" nonce="n0">/);
        expect(html).toMatch(/<link rel="prefetch" crossorigin href="https:\/\/cdn\.test\/app\/js\/c-[^"]+\.js">/);
        expect(html).toContain('<title>T</title>');
        expect(html).toContain('<meta name="description" content="d">');
        expect(html).not.toContain('modulepreload'); // the external is not a file of the build
    });

    it('keeps externals, drops console, writes the ssr manifest and warns about big chunks', () => {
        const main = out.read(out.list.find((f) => /^js\/main-/.test(f))!);
        expect(main).toMatch(/from"ext-lib"/);
        expect(main).not.toContain('gone');
        const ssr = JSON.parse(out.read('.vite/ssr-manifest.json'));
        expect(ssr['src/main.js'][0]).toMatch(/^https:\/\/cdn\.test\/app\/js\/main-/);
        expect(out.log).toContain('larger than');
    });
});

describe('page options', () => {
    it('replaces the title, adds meta, favicon, preconnect and tags', () => {
        const page = applyHtmlOptions('<html><head><title>old</title><link rel="icon" href="/x.ico"></head><body></body></html>', {
            title: 'New', favicon: '/f.svg', preconnect: ['https://api.test'], tags: [{ tag: 'script', attrs: { src: 's.js', defer: true }, injectTo: 'body' }],
        }, '/sub/');
        expect(page).toContain('<title>New</title>');
        expect(page).not.toContain('x.ico');
        expect(page).toContain('<link rel="icon" href="/sub/f.svg">');
        expect(page).toContain('<link rel="preconnect" href="https://api.test" crossorigin>');
        expect(page).toMatch(/<script src="s\.js" defer><\/script>\s*<\/body>/);
    });

    it('puts the nonce on scripts, styles and stylesheet links only', () => {
        const page = addNonce('<script src="a.js"></script><style></style><link rel="stylesheet" href="b.css" /><link rel="icon" href="i.png">', 'n');
        expect(page).toBe('<script src="a.js" nonce="n"></script><style nonce="n"></style><link rel="stylesheet" href="b.css" nonce="n" /><link rel="icon" href="i.png">');
    });
});

describe('dev server access', () => {
    it('answers localhost, IPs and allowed hosts only', () => {
        expect(hostAllowed('localhost:5173', {})).toBe(true);
        expect(hostAllowed('app.localhost', {})).toBe(true);
        expect(hostAllowed('192.168.1.4:5173', {})).toBe(true);
        expect(hostAllowed('[::1]:5173', {})).toBe(true);
        expect(hostAllowed('evil.example.com', {})).toBe(false);
        expect(hostAllowed('dev.example.test', { allowedHosts: ['.example.test'] })).toBe(true);
        expect(hostAllowed('anything', { allowedHosts: true })).toBe(true);
    });

    it('allows cross-origin reads from localhost pages by default', () => {
        expect(corsOrigin('http://localhost:3000', {})).toBe('http://localhost:3000');
        expect(corsOrigin('https://evil.example.com', {})).toBeNull();
        expect(corsOrigin('https://evil.example.com', { cors: true })).toBe('*');
        expect(corsOrigin('https://app.test', { cors: { origin: ['https://app.test'] } })).toBe('https://app.test');
    });
});

/** A project with the repo's node_modules (React) beside its own files. */
function buildWith(files: Record<string, string>, extraNodeModules: Record<string, string> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-options-'));
    dirs.push(dir);
    const all: Record<string, string> = {
        'package.json': '{"type":"module","dependencies":{"react":"*"}}',
        'index.html': '<!DOCTYPE html><html><head><title>x</title></head><body><script type="module" src="/src/main.js"></script></body></html>',
        ...files,
    };
    for (const [rel, content] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    fs.mkdirSync(path.join(dir, 'node_modules'));
    for (const pkg of ['react']) fs.symlinkSync(path.join(repo, 'node_modules', pkg), path.join(dir, 'node_modules', pkg), 'dir');
    for (const [rel, content] of Object.entries(extraNodeModules)) {
        fs.mkdirSync(path.dirname(path.join(dir, 'node_modules', rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, 'node_modules', rel), content);
    }
    const r = spawnSync(process.execPath, [cli, 'build'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', LUNX_SKIP_SECURITY: '1', LUNX_BUILD_CACHE: '0' } });
    const dist = path.join(dir, 'dist');
    const list = r.status === 0 ? (fs.readdirSync(dist, { recursive: true }) as string[]).map((f) => f.split(path.sep).join('/')).filter((f) => !/\.(gz|br)$/.test(f)) : [];
    const js = list.filter((f) => f.endsWith('.js'));
    return { ok: r.status === 0, list, js, read: (f: string) => fs.readFileSync(path.join(dist, f), 'utf8'), log: r.stdout + r.stderr };
}

describe('env, chunk and CSS options', () => {
    const main = "import { useState } from 'react';\ndocument.title = String(useState);\nimport('./lazy.js').then((m) => m.run());\n";
    const lazy = { 'src/lazy.js': 'export const run = () => document.body.dataset.x;\n' };

    it('exposes envPrefix variables from envDir only, and refuses an empty prefix', () => {
        const files = {
            'lunx.config.js': "export default { envPrefix: 'APP_', envDir: 'env' };",
            'env/.env': 'APP_KEY=from-env-dir\nVITE_KEY=not-exposed\n',
            '.env': 'APP_OTHER=root-file\n',
            'src/main.js': 'document.title = [import.meta.env.APP_KEY, import.meta.env.VITE_KEY, import.meta.env.APP_OTHER].join("|");\n',
        };
        const out = buildWith(files);
        expect(out.ok).toBe(true);
        const code = out.js.map(out.read).join('\n');
        expect(code).toContain('from-env-dir');
        expect(code).not.toContain('not-exposed');
        expect(code).not.toContain('root-file');
        const empty = buildWith({ ...files, 'lunx.config.js': "export default { envPrefix: '' };" });
        expect(empty.ok).toBe(false);
        expect(empty.log).toContain("envPrefix contains ''");
    }, 60_000);

    it('splits node_modules by strategy', () => {
        const vendor = buildWith({ 'lunx.config.js': "export default { build: { splitChunks: 'single-vendor' } };", 'src/main.js': main, ...lazy });
        expect(vendor.js.some((f) => /\/vendor\.[^/]+\.js$/.test(f))).toBe(true);
        const perPackage = buildWith({ 'lunx.config.js': "export default { build: { splitChunks: 'split-by-module' } };", 'src/main.js': main, ...lazy });
        expect(perPackage.js.some((f) => /\/lib-react\.[^/]+\.js$/.test(f))).toBe(true);
        const one = buildWith({ 'lunx.config.js': "export default { build: { splitChunks: 'all-in-one', reportCompressedSize: false } };", 'src/main.js': main, ...lazy });
        expect(one.js).toHaveLength(1);
        expect(one.read(one.js[0]!)).toContain('dataset.x');
        expect(one.log).not.toContain('Gzip Transferred');
    }, 120_000);

    it("reads a vite.config's manualChunks function", () => {
        const out = buildWith({
            'vite.config.js': "export default { build: { rollupOptions: { output: { manualChunks(id) { return id.includes('node_modules') ? 'deps' : undefined; } } } } };",
            'src/main.js': main,
            ...lazy,
        });
        expect(out.ok).toBe(true);
        expect(out.js.some((f) => /\/deps\.[^/]+\.js$/.test(f))).toBe(true);
    }, 60_000);

    it('passes css.preprocessorOptions (additionalData included) and css.modules options', () => {
        const out = buildWith({
            'lunx.config.js': `export default { css: {
  preprocessorOptions: { less: { additionalData: '@brand: teal;', math: 'always' } },
  modules: { generateScopedName: 'x-[local]-[hash:base64:5]', localsConvention: 'camelCaseOnly' },
} };`,
            'src/main.js': "import './a.less';\nimport s from './b.module.css';\ndocument.title = s.fooBar;\n",
            'src/a.less': '.a { color: @brand; }\n',
            'src/b.module.css': '.foo-bar { color: red; }\n',
        }, {
            // A stand-in for less: it echoes what it was given.
            'less/package.json': '{"name":"less","main":"index.js"}',
            'less/index.js': "module.exports = { render: async (src, opts) => ({ css: src.replace(/@brand: (\\w+);/, '').replace('@brand', /@brand: (\\w+);/.exec(src)[1]) + `.math-${opts.math} { color: blue; }`, imports: [] }) };",
        });
        expect(out.log).not.toContain('Error');
        expect(out.ok).toBe(true);
        const css = out.list.filter((f) => f.endsWith('.css')).map(out.read).join('\n');
        expect(css).toMatch(/\.a\s*\{\s*color:\s*teal/);
        expect(css).toContain('.math-always');
        expect(css).toMatch(/\.x-foo-bar-[\w-]+\s*\{/);
        const code = out.js.map(out.read).join('\n');
        expect(code).toMatch(/fooBar/);
        expect(code).not.toMatch(/"foo-bar"/);
    }, 60_000);
});

describe('server.warmup', () => {
    it('compiles clientFiles once the server is up', async () => {
        const { freePort, stopProcess } = await import('./dev-process.js');
        const { spawn } = await import('child_process');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-warmup-'));
        dirs.push(dir);
        const files: Record<string, string> = {
            'package.json': '{"type":"module"}',
            'index.html': '<!DOCTYPE html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
            'lunx.config.js': "export default { server: { warmup: { clientFiles: ['./src/*.js', 'src/deep/**/*.ts'] } } };",
            'src/main.js': 'document.title = "a";\n',
            'src/other.js': 'export const b = 1;\n',
            'src/deep/x/y.ts': 'export const c: number = 2;\n',
            'src/skip.css': 'a{}',
        };
        for (const [rel, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
        }
        const port = await freePort();
        const child = spawn(process.execPath, [cli, 'dev', '--port', String(port)], { cwd: dir, env: { ...process.env, NODE_OPTIONS: '', DEBUG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout!.on('data', (d) => (output += d));
        child.stderr!.on('data', (d) => (output += d));
        try {
            const deadline = Date.now() + 30_000;
            while (!/warmed \d+ modules/.test(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
            expect(output).toMatch(/warmed 3 modules/);
        } finally {
            await stopProcess(child);
        }
    }, 40_000);
});
