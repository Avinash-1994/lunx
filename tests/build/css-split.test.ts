/**
 * CSS code splitting, as in Vite: CSS that only lazy chunks import goes in
 * their own stylesheets, which the chunk loads before its import() resolves;
 * the page's stylesheet keeps what loads up front. `build.cssCodeSplit: false`
 * puts everything in one file. scripts/output-parity.mjs checks it in Chromium.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'dist', 'cli.js');
const dirs: string[] = [];

function build(config: string): { dir: string; files: string[]; read: (f: string) => string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-css-split-'));
    dirs.push(dir);
    const files: Record<string, string> = {
        'package.json': '{"type":"module"}',
        'lunx.config.js': config,
        'index.html': '<!DOCTYPE html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
        'src/main.js': "import './app.css';\nimport { shared } from './shared.js';\ndocument.body.dataset.s = shared;\nimport('./lazy.js').then((m) => m.run());\n",
        'src/app.css': '.app { color: rgb(1, 1, 1); }\n',
        'src/shared.js': "import './shared.css';\nexport const shared = 'shared';\n",
        'src/shared.css': '.shared { color: rgb(2, 2, 2); }\n',
        'src/lazy.js': "import './lazy.css';\nimport { shared } from './shared.js';\nexport const run = () => shared;\n",
        'src/lazy.css': '.lazy { color: rgb(3, 3, 3); }\n',
    };
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    const r = spawnSync(process.execPath, [cli, 'build'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', LUNX_SKIP_SECURITY: '1', LUNX_BUILD_CACHE: '0' } });
    if (r.status !== 0) throw new Error(r.stdout + r.stderr);
    const assets = path.join(dir, 'dist', 'assets');
    return { dir, files: fs.readdirSync(assets).filter((f) => !/\.(gz|br|map)$/.test(f)), read: (f) => fs.readFileSync(path.join(assets, f), 'utf8') };
}

afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CSS code splitting', () => {
    it('gives a lazy chunk its own stylesheet, loaded before its import() resolves', () => {
        const { files, read } = build('export default {};\n');
        const page = files.find((f) => f.startsWith('style.'))!;
        expect(read(page)).toMatch(/\.app\{color:#010101\}/);
        expect(read(page)).toMatch(/\.shared\{color:#020202\}/); // imported up front too
        expect(read(page)).not.toMatch(/\.lazy/);
        const lazyCss = files.find((f) => f.startsWith('lazy.') && f.endsWith('.css'))!;
        expect(read(lazyCss)).toBe('.lazy{color:#030303}');
        const lazyJs = read(files.find((f) => f.startsWith('lazy.') && f.endsWith('.js'))!);
        expect(lazyJs).toContain(`await new Promise(`);
        expect(lazyJs).toContain(`new URL("./${lazyCss}",import.meta.url)`);
    });

    it('puts all CSS in one file with build.cssCodeSplit: false', () => {
        const { files, read } = build('export default { build: { cssCodeSplit: false } };\n');
        expect(files.filter((f) => f.endsWith('.css'))).toHaveLength(1);
        expect(read(files.find((f) => f.endsWith('.css'))!)).toMatch(/\.lazy\{color:#030303\}/);
        expect(files.filter((f) => f.endsWith('.js')).map(read).join('\n')).not.toContain('await new Promise(');
    });
});
