/**
 * The shortcuts a build takes before and after Rolldown runs:
 *  - configs Node can run as they are are imported without a bundle, with
 *    framework plugins stubbed by a resolve hook that is removed afterwards;
 *    everything else is still bundled;
 *  - lightningcss loads without detect-libc (and child_process);
 *  - OSV answers are cached once per machine;
 *  - precompressed HTML matches the page after SRI was injected.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { pathToFileURL } from 'url';

import moduleApi from 'module';

const repo = process.cwd();
const repoModules = path.resolve(repo, 'node_modules');
// The built CLI (CI builds before testing): tsx would compile TypeScript configs and load child_process itself.
const dist = (file: string) => pathToFileURL(path.resolve(repo, 'dist', file)).href;
/** Node ≥ 22.15 / 23.5: configs can be imported without a bundle. */
const nativeConfigs = typeof (moduleApi as any).registerHooks === 'function';

function project(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-startup-'));
    fs.symlinkSync(repoModules, path.join(root, 'node_modules'), 'dir');
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

// Dynamic import and resolve hooks need a real Node process, not Jest's VM.
function run(root: string, code: string, env: Record<string, string> = {}): any {
    const script = path.join(root, `run-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(script, code);
    const out = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', ...env } });
    const last = out.stdout.trim().split('\n').pop() || '';
    try {
        return JSON.parse(last);
    } catch {
        throw new Error(`no result\nstdout: ${out.stdout}\nstderr: ${out.stderr}`);
    }
}

const STUBS = `{ vite: 'export const defineConfig = (c) => c;', '@vitejs/plugin-react': "export default () => ({ name: 'stub-react' });", semver: "export const valid = () => 'stub';" }`;

function loadConfig(root: string, file: string, env: Record<string, string> = {}): any {
    return run(root, `import { importBundled } from ${JSON.stringify(dist('lib/load-module.js'))};
const config = await importBundled(${JSON.stringify(path.join(root, file))}, { root: ${JSON.stringify(root)}, stubs: ${STUBS} });
// Stubs apply to the config alone: the rest of the process gets the real package.
const semverIsReal = (await import('semver')).valid('1.2.3') === '1.2.3';
console.log(JSON.stringify({ ...config, plugins: (config.plugins ?? []).map((p) => p.name), semverIsReal }));
`, env);
}

const how = `new Error().stack.includes('node_modules/.lunx') ? 'bundled' : 'native'`;

describe('config loading', () => {
    it('imports a plain ESM config directly, with stubs for that config only', () => {
        const root = project({
            'vite.config.mjs': `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { valid } from 'semver';
export default defineConfig({ base: '/app/', plugins: [react()], semver: valid('1.0.0'), how: ${how}, url: import.meta.url });`,
        });
        const config = loadConfig(root, 'vite.config.mjs');
        expect(config.how).toBe(nativeConfigs ? 'native' : 'bundled');
        expect(config.base).toBe('/app/');
        expect(config.plugins).toEqual(['stub-react']);
        expect(config.url.split('?')[0]).toBe(pathToFileURL(fs.realpathSync(path.join(root, 'vite.config.mjs'))).href);
        expect(config.semver).toBe('stub');
        expect(config.semverIsReal).toBe(true);
    }, 60_000);

    it.each([['natively', {}], ['bundled', { LUNX_CONFIG_BUNDLE: '1' }]])('imports through a symlinked project path %s (macOS /var is /private/var)', (mode, env) => {
        const real = project({ 'vite.config.mjs': `import react from '@vitejs/plugin-react';\nexport default { plugins: [react()], how: ${how}, url: import.meta.url };` });
        const link = `${real}-link`;
        fs.symlinkSync(real, link, 'dir');
        const config = loadConfig(link, 'vite.config.mjs', env);
        expect(config.how).toBe(nativeConfigs && mode === 'natively' ? 'native' : 'bundled');
        expect(config.plugins).toEqual(['stub-react']);
        // Either way the config sees its real path, as Node reports it.
        expect(config.url.split('?')[0]).toBe(pathToFileURL(fs.realpathSync(path.join(real, 'vite.config.mjs'))).href);
    }, 60_000);

    it('reads an edited config again in the same process', () => {
        const root = project({ 'vite.config.mjs': `export default { base: '/one/' };` });
        const result = run(root, `import fs from 'node:fs';
import { importBundled } from ${JSON.stringify(dist('lib/load-module.js'))};
const file = ${JSON.stringify(path.join(root, 'vite.config.mjs'))};
const first = await importBundled(file, { root: ${JSON.stringify(root)} });
const again = await importBundled(file, { root: ${JSON.stringify(root)} });
fs.writeFileSync(file, "export default { base: '/two/' };");
const edited = await importBundled(file, { root: ${JSON.stringify(root)} });
console.log(JSON.stringify({ first: first.base, same: first === again, edited: edited.base }));
`);
        expect(result).toEqual({ first: '/one/', same: true, edited: '/two/' });
    }, 60_000);

    it('still bundles configs that rely on what bundling provides', () => {
        const root = project({
            'dirname.config.mjs': `export default { dir: __dirname, how: ${how} };`,
            'local.config.mjs': `import { base } from './shared.mjs';\nexport default { base, how: ${how} };`,
            'shared.mjs': `export const base = '/shared/';`,
        });
        const dirname = loadConfig(root, 'dirname.config.mjs');
        expect(dirname).toMatchObject({ how: 'bundled', dir: fs.realpathSync(root) });
        const local = loadConfig(root, 'local.config.mjs');
        expect(local).toMatchObject({ how: 'bundled', base: '/shared/' });
    }, 60_000);

    it('falls back to bundling when the config does not run as it is', () => {
        const root = project({
            'package.json': JSON.stringify({ type: 'module' }),
            // An enum needs more than type stripping.
            'lunx.config.ts': `enum Mode { A = 'a' }\nexport default { mode: Mode.A, how: ${how} };`,
        });
        expect(loadConfig(root, 'lunx.config.ts')).toMatchObject({ mode: 'a', how: 'bundled' });
    }, 60_000);

    it('LUNX_CONFIG_BUNDLE=1 always bundles', () => {
        const root = project({ 'vite.config.mjs': `export default { how: ${how} };` });
        expect(loadConfig(root, 'vite.config.mjs', { LUNX_CONFIG_BUNDLE: '1' }).how).toBe('bundled');
    }, 60_000);
});

describe('lightningcss loader', () => {
    it('minifies CSS without loading child_process', () => {
        const root = project({});
        const result = run(root, `import { lightningcss } from ${JSON.stringify(dist('lib/lightningcss.js'))};
const code = lightningcss().transform({ filename: 'a.css', code: Buffer.from('.a { color: #ff0000; }'), minify: true }).code.toString();
console.log(JSON.stringify({ code, childProcess: process.moduleLoadList.includes('NativeModule child_process') }));
`);
        expect(result.code).toBe('.a{color:red}');
        if (process.platform !== 'linux' || fs.existsSync('/usr/bin/ldd')) expect(result.childProcess).toBe(false);
    }, 60_000);
});

describe('advisory cache directory', () => {
    it('is shared per machine, and falls back to the project when that is not writable', () => {
        const root = project({});
        const shared = path.join(root, 'shared-cache');
        const code = `import { advisoryCacheDir } from '@lunx/security';\nconsole.log(JSON.stringify({ dir: advisoryCacheDir(${JSON.stringify(root)}) }));\n`;
        expect(run(root, code, { LUNX_ADVISORY_CACHE_DIR: shared }).dir).toBe(shared);
        // A file where the cache directory would go: not usable.
        fs.writeFileSync(path.join(root, 'not-a-dir'), '');
        expect(run(root, code, { LUNX_ADVISORY_CACHE_DIR: path.join(root, 'not-a-dir', 'cache') }).dir).toBe(path.join(root, '.lunx', 'security'));
    }, 60_000);
});

describe('precompressed output', () => {
    let root: string;

    beforeAll(() => {
        root = project({
            'package.json': JSON.stringify({ name: 'app', private: true, type: 'module' }),
            // Over the 1 kB threshold, so the page gets .gz / .br copies.
            'index.html': `<!doctype html><html><head><title>app</title><!-- ${'x'.repeat(1500)} --></head><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>`,
            'src/main.js': `document.getElementById('app').textContent = 'hello ' + ${JSON.stringify('y'.repeat(2000))};`,
        });
        const out = spawnSync(process.execPath, [path.resolve(repo, 'dist/cli.js'), 'build', '--root', root], {
            cwd: root,
            encoding: 'utf8',
            // SRI is part of the security step, which CI otherwise skips.
            env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production', LUNX_SKIP_SECURITY: '', LUNX_ADVISORY_CACHE_DIR: path.join(root, '.advisories') },
        });
        if (out.status !== 0) throw new Error(`build failed\n${out.stdout}\n${out.stderr}`);
    }, 120_000);

    it('compresses the HTML after SRI was injected', () => {
        const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
        expect(html).toContain('integrity="sha384-');
        expect(zlib.gunzipSync(fs.readFileSync(path.join(root, 'dist', 'index.html.gz'))).toString()).toBe(html);
        expect(zlib.brotliDecompressSync(fs.readFileSync(path.join(root, 'dist', 'index.html.br'))).toString()).toBe(html);
    });

    it('compresses the scripts', () => {
        const assets = fs.readdirSync(path.join(root, 'dist', 'assets'));
        const js = assets.find((f) => f.endsWith('.js'))!;
        expect(assets).toEqual(expect.arrayContaining([`${js}.gz`, `${js}.br`]));
        expect(zlib.gunzipSync(fs.readFileSync(path.join(root, 'dist', 'assets', `${js}.gz`))).toString()).toBe(fs.readFileSync(path.join(root, 'dist', 'assets', js), 'utf8'));
    });
});
