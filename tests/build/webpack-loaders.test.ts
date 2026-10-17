/**
 * `loaders` (webpack's module.rules): webpack loaders run in builds and in dev
 * with the loader context they expect (sync / async, options, raw, pitch,
 * emitFile, CommonJS output) and asset `type`s.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { startDev, stopProcess, removeDir } from './dev-process.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'dist', 'cli.js');

const files: Record<string, string> = {
    'package.json': '{"type":"module"}',
    'index.html': '<!DOCTYPE html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
    'lunx.config.js': `export default { loaders: [
  { test: /\\.txt$/, use: ['./loaders/wrap-loader.cjs', { loader: './loaders/upper-loader.cjs', options: { suffix: '!' } }] },
  { test: /\\.kv$/, use: './loaders/kv-loader.cjs' },
  { test: /\\.bin$/, use: './loaders/size-loader.cjs' },
  { test: /\\.png$/, use: './loaders/file-loader.cjs' },
  { test: /\\.pitch$/, use: ['./loaders/pitch-loader.cjs', './loaders/never-loader.cjs'] },
  { test: /\\.esm$/, use: './loaders/esm-loader.mjs' },
  { test: /\\.dat$/, type: 'asset/source' },
] };`,
    'loaders/upper-loader.cjs': 'module.exports = function (source) { return source.trim().toUpperCase() + (this.getOptions().suffix || ""); };',
    'loaders/wrap-loader.cjs': 'module.exports = function (source) { return "export default " + JSON.stringify(source) + ";"; };',
    'loaders/kv-loader.cjs': 'module.exports = function (source) { const done = this.async(); const at = this.resourcePath.split("/").pop(); setTimeout(() => done(null, "export default " + JSON.stringify({ at, ...Object.fromEntries(source.trim().split("\\n").map((l) => l.split(": "))) }) + ";"), 5); };',
    'loaders/size-loader.cjs': 'module.exports = function (buf) { return "export default " + (Buffer.isBuffer(buf) ? buf.length : -1) + ";"; }; module.exports.raw = true;',
    'loaders/file-loader.cjs': 'module.exports = function (content) { const name = "media/" + require("path").basename(this.resourcePath); this.emitFile(name, content); return "module.exports = __webpack_public_path__ + " + JSON.stringify(name) + ";"; }; module.exports.raw = true;',
    'loaders/pitch-loader.cjs': 'module.exports = function () { return "not reached"; }; module.exports.pitch = function (remaining) { return "export default " + JSON.stringify("pitched " + remaining.split("!").length) + ";"; };',
    'loaders/never-loader.cjs': 'module.exports = function () { throw new Error("the pitch skips me"); };',
    'loaders/esm-loader.mjs': 'export default function (source) { return "export default " + JSON.stringify("esm:" + source.trim()) + ";"; }',
    'src/main.js': [
        "import txt from './a.txt';",
        "import kv from './b.kv';",
        "import size from './c.bin';",
        "import png from './d.png';",
        "import pitched from './e.pitch';",
        "import esm from './f.esm';",
        "import dat from './g.dat';",
        'window.__out = { txt, kv, size, png, pitched, esm, dat };',
        'document.title = JSON.stringify(window.__out);',
    ].join('\n'),
    'src/a.txt': 'hello\n',
    'src/b.kv': 'name: lunx\nkind: tool\n',
    'src/c.bin': '12345',
    'src/d.png': 'PNGDATA',
    'src/e.pitch': 'x',
    'src/f.esm': 'mod\n',
    'src/g.dat': 'raw text',
};

describe('webpack loaders', () => {
    let root: string;
    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-loaders-'));
        for (const [rel, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
            fs.writeFileSync(path.join(root, rel), content);
        }
    });
    afterAll(() => removeDir(root));

    it('run in a build: chained, async, raw, pitching, ESM loaders, emitted files and asset types', () => {
        const r = spawnSync(process.execPath, [cli, 'build'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', LUNX_SKIP_SECURITY: '1', LUNX_BUILD_CACHE: '0' } });
        expect(r.stdout + r.stderr).not.toMatch(/error/i);
        expect(r.status).toBe(0);
        const dist = path.join(root, 'dist');
        const js = (fs.readdirSync(path.join(dist, 'assets')) as string[]).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dist, 'assets', f), 'utf8')).join('\n');
        expect(js).toContain('HELLO!');
        expect(js).toContain('lunx');
        expect(js).toContain('b.kv');
        expect(js).toMatch(/\b5\b/);
        expect(js).toContain('media/d.png');
        expect(js).toContain('pitched 2');
        expect(js).not.toContain('not reached');
        expect(js).toContain('esm:mod');
        expect(js).toContain('raw text');
        expect(fs.readFileSync(path.join(dist, 'media/d.png'), 'utf8')).toBe('PNGDATA');
    }, 60_000);

    describe('in dev', () => {
        let dev: ChildProcess;
        let port: number;
        const get = (url: string) => fetch(`http://localhost:${port}${url}`).then(async (r) => ({ status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() }));
        beforeAll(async () => {
            fs.rmSync(path.join(root, '.lunx'), { recursive: true, force: true });
            ({ child: dev, port } = await startDev(cli, root));
        }, 60_000);
        afterAll(() => stopProcess(dev));

        it('serve imports of matched files as the loaders output, CommonJS made an ES module', async () => {
            const main = await get('/src/main.js');
            expect(main.body).toContain("'./a.txt?import'");
            expect(main.body).toContain("'./b.kv?import'");
            const txt = await get('/src/a.txt?import');
            expect(txt.type).toContain('javascript');
            expect(txt.body).toContain('HELLO!');
            expect((await get('/src/b.kv?import')).body).toContain('lunx');
            expect((await get('/src/c.bin?import')).body).toMatch(/export default 5/);
            const png = await get('/src/d.png?import');
            expect(png.body).toContain('export default');
            expect(png.body).toContain('media/d.png');
            expect((await get('/media/d.png')).body).toBe('PNGDATA');
            expect((await get('/src/e.pitch?import')).body).toContain('pitched 2');
            expect((await get('/src/g.dat?import')).body).toContain('raw text');
            // Fetched as itself (an <img src>), a file stays a file.
            expect((await get('/src/d.png')).body).toBe('PNGDATA');
        });
    });

    it('run in bundled dev too', async () => {
        const config = fs.readFileSync(path.join(root, 'lunx.config.js'), 'utf8');
        fs.writeFileSync(path.join(root, 'lunx.config.js'), config.replace('export default { loaders:', 'export default { server: { bundle: true }, loaders:'));
        const { child, port } = await startDev(cli, root);
        try {
            const code = await (await fetch(`http://localhost:${port}/@lunx/bundle/main.js`)).text();
            for (const s of ['HELLO!', 'lunx', 'pitched 2', 'esm:mod', 'raw text', 'media/d.png']) expect(code).toContain(s);
        } finally {
            await stopProcess(child);
            fs.writeFileSync(path.join(root, 'lunx.config.js'), config);
        }
    }, 60_000);
});
