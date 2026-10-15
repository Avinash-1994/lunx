/**
 * Build features other tools have that lunx was missing (reports/BUILD_TOOL_LANDSCAPE.md §9):
 * `` import(`./x/${name}.js`) ``, `?worker` imports, `build.target`, `build.manifest`,
 * federation type hints, a remote compile cache, plain error output.
 * The browser checks are in scripts/output-parity.mjs; these check the files.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveTargets } from '../../src/build/targets.js';
import { unzip, zipDir, dtsSides } from '../../src/federation/types.js';
import { configureRemoteCache } from '../../src/build/remote-cache.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'dist', 'cli.js');
const dirs: string[] = [];

function project(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-features-'));
    dirs.push(dir);
    const all: Record<string, string> = {
        'package.json': '{"type":"module"}',
        'index.html': '<!DOCTYPE html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
        ...files,
    };
    for (const [rel, content] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

function build(dir: string, env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [cli, 'build'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', LUNX_SKIP_SECURITY: '1', LUNX_BUILD_CACHE: '0', ...env } });
}

function built(dir: string): { files: string[]; js: string } {
    const r = build(dir);
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const assets = path.join(dir, 'dist', 'assets');
    const files = fs.readdirSync(assets).filter((f) => !/\.(gz|br|map)$/.test(f));
    return { files, js: files.filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n') };
}

afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('build features', () => {
    it('bundles every file a template-literal import() can reach', () => {
        const { files, js } = built(project({
            'src/main.js': 'const lang = location.hash.slice(1) || "en";\nimport(`./locales/${lang}.js`).then((m) => console.log(m.default));\n',
            'src/locales/en.js': 'export default "hello";\n',
            'src/locales/es.js': 'export default "hola";\n',
        }));
        expect(files.some((f) => f.startsWith('en.'))).toBe(true);
        expect(files.some((f) => f.startsWith('es.'))).toBe(true);
        expect(js).toContain('"./locales/es.js":()=>import(');
    });

    it('builds ?worker, ?worker&url and ?worker&inline imports', () => {
        const { files, js } = built(project({
            'src/main.js': "import W from './w.js?worker';\nimport I from './w.js?worker&inline';\nimport url from './w.js?worker&url';\nconsole.log(new W(), new I(), url);\n",
            'src/w.js': 'self.onmessage = (e) => self.postMessage(e.data * 2);\n',
        }));
        const worker = files.find((f) => f.startsWith('w.') && f.endsWith('.js'))!;
        expect(worker).toBeTruthy();
        expect(js).toMatch(new RegExp(`new Worker\\(new URL\\(.\\.\\./assets/${worker.replace(/[.$]/g, '\\$&')}.,import\\.meta\\.url\\),\\{type:.module.`));
        expect(js).toContain('URL.createObjectURL(new Blob(');
    });

    it('lowers syntax for build.target; the default (baseline) keeps what those browsers run', () => {
        const code = 'class A { static #p = 1; static p() { return A.#p; } }\nconst o = {}; o.b ??= 2;\nconsole.log(A.p(), o.b);\n';
        const lowered = built(project({ 'lunx.config.js': "export default { build: { target: 'es2018' } };\n", 'src/main.js': code })).js;
        expect(lowered).not.toContain('??=');
        expect(lowered).not.toContain('#');
        const modern = built(project({ 'src/main.js': code })).js;
        expect(modern).toContain('??=');
    });

    it('writes .vite/manifest.json with build.manifest', () => {
        const dir = project({
            'lunx.config.js': 'export default { build: { manifest: true } };\n',
            'src/main.js': "import './a.css';\nimport('./lazy.js').then((m) => m.run());\n",
            'src/a.css': '.a { color: red; }\n',
            'src/lazy.js': "import './lazy.css';\nexport const run = () => document.title;\n",
            'src/lazy.css': '.l { color: blue; }\n',
        });
        built(dir);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'dist', '.vite', 'manifest.json'), 'utf8'));
        expect(manifest['src/main.js']).toMatchObject({ isEntry: true, src: 'src/main.js', dynamicImports: ['src/lazy.js'] });
        expect(manifest['src/main.js'].css[0]).toMatch(/^assets\/style\..+\.css$/);
        expect(manifest['src/lazy.js']).toMatchObject({ isDynamicEntry: true });
        expect(manifest['src/lazy.js'].css[0]).toMatch(/^assets\/lazy\..+\.css$/);
    });

    it('moves license notices beside the chunk by default, keeps them with legalComments: inline', () => {
        const files = {
            'node_modules/licensed/package.json': '{"name":"licensed","version":"1.0.0","type":"module","main":"index.js"}',
            'node_modules/licensed/index.js': '/*! licensed v1 | MIT */\nexport function v() { return Math.random(); }\n',
            'src/main.js': "import { v } from 'licensed';\nconsole.log(v());\n",
        };
        const linked = built(project(files));
        expect(linked.js).not.toContain('licensed v1');
        const notice = linked.files.find((f) => f.endsWith('.LICENSE.txt'))!;
        expect(notice).toMatch(/^main\..+\.js\.LICENSE\.txt$/);
        expect(linked.js).toContain(`/*! Licenses: ${notice} */`);
        expect(built(project({ ...files, 'lunx.config.js': "export default { build: { legalComments: 'inline' } };\n" })).js).toContain('licensed v1');
    });

    it('prints build errors without colour codes under NO_COLOR', () => {
        const r = build(project({ 'src/main.js': "import x from './missing.js';\nconsole.log(x);\n" }), { NO_COLOR: '1' });
        expect(r.status).not.toBe(0);
        expect(r.stdout + r.stderr).toContain("Could not resolve './missing.js'");
        expect(r.stdout + r.stderr).not.toContain(String.fromCharCode(27) + '[');
    });
});

describe('build targets', () => {
    it('reads build.target, Vite presets and esnext', () => {
        const root = project({});
        expect(resolveTargets(root, 'es2020').js).toEqual(['es2020']);
        expect(resolveTargets(root, 'baseline-widely-available').js).toEqual(['chrome111', 'edge111', 'firefox114', 'safari16.4']);
        expect(resolveTargets(root, 'esnext')).toEqual({ js: null, css: null });
        expect(resolveTargets(root, ['chrome90', 'safari14.1']).css).toEqual({ chrome: 90 << 16, safari: (14 << 16) | (1 << 8) });
        expect(resolveTargets(root, undefined).js).toEqual(['chrome111', 'edge111', 'firefox114', 'safari16.4']);
    });
});

describe('federation type hints', () => {
    it('zips and unzips the @mf-types folder', () => {
        const src = project({ 'a.d.ts': 'export declare const a: number;\n', 'nested/b.d.ts': 'export {};\n' });
        fs.rmSync(path.join(src, 'package.json'));
        fs.rmSync(path.join(src, 'index.html'));
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-unzip-'));
        dirs.push(out);
        unzip(zipDir(src), out);
        expect(fs.readFileSync(path.join(out, 'a.d.ts'), 'utf8')).toBe('export declare const a: number;\n');
        expect(fs.existsSync(path.join(out, 'nested', 'b.d.ts'))).toBe(true);
    });

    it('is on by default, and per side with federation.dts', () => {
        expect(dtsSides({ name: 'x' })).toEqual({ generate: true, consume: true });
        expect(dtsSides({ name: 'x', dts: false })).toEqual({ generate: false, consume: false });
        expect(dtsSides({ name: 'x', dts: { consumeTypes: false } })).toEqual({ generate: true, consume: false });
    });
});

describe('remote cache', () => {
    it('needs what each provider uses, and rejects unknown providers', () => {
        expect(configureRemoteCache(undefined)).toBeNull();
        expect(() => configureRemoteCache({ provider: 'http' })).toThrow(/baseUrl/);
        expect(() => configureRemoteCache({ provider: 'lunx-cloud' })).toThrow(/unknown provider/);
        expect(configureRemoteCache({ provider: 'http', baseUrl: 'https://cache.example.com', readOnly: true })?.readOnly).toBe(true);
        configureRemoteCache(undefined);
    });
});
