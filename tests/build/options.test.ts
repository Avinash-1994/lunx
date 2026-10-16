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
