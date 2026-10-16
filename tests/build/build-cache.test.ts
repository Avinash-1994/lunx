/**
 * The whole-build cache: `lunx build` reuses the last output when no input,
 * option or output changed. A build that must run anyway (first build, other
 * options, output removed) reads its inputs while Rolldown works instead of
 * before it starts.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkBuild, recordBuild, startInputScans } from '../../src/build/build-cache.js';

let root: string;
let outDir: string;
const options = { outDir: 'dist', mode: 'production' };

function write(file: string, content: string) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
}

/** A build: check, "bundle" (write the output), record. */
async function build(opts = options) {
    const check = checkBuild(root, opts);
    if (check.hit) return check;
    startInputScans();
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), '<script src="assets/main.js"></script>');
    fs.writeFileSync(path.join(outDir, 'assets/main.js'), `console.log(${fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8').length})`);
    await recordBuild(root, check.pending, outDir);
    return check;
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-build-cache-'));
    outDir = path.join(root, 'dist');
    write('package.json', '{}');
    write('index.html', '<script type="module" src="/src/main.ts"></script>');
    write('src/main.ts', 'console.log(1);');
    write('node_modules/dep/index.js', 'export {};');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('whole-build cache', () => {
    it('reuses an untouched build, and records inputs without the output or node_modules', async () => {
        expect((await build()).hit).toBe(false);
        const entry = JSON.parse(fs.readFileSync(path.join(root, '.lunx/build-cache', fs.readdirSync(path.join(root, '.lunx/build-cache'))[0]!), 'utf8'));
        expect(Object.keys(entry.inputs).sort()).toEqual(['index.html', 'package.json', path.join('src', 'main.ts')].sort());
        expect((await build()).hit).toBe(true);
    });

    it('rebuilds after an input changes or a file is added', async () => {
        await build();
        write('src/main.ts', 'console.log(22);');
        const changed = checkBuild(root, options);
        expect(changed.hit).toBe(false);
        expect(changed.pending.inputs).not.toBeNull(); // read up front, to decide
        await build();
        expect(checkBuild(root, options).hit).toBe(true);
        write('src/extra.ts', 'export {};');
        expect(checkBuild(root, options).hit).toBe(false);
    });

    it('rebuilds once the output is removed or edited, reading inputs during the build', async () => {
        await build();
        fs.rmSync(outDir, { recursive: true });
        const removed = checkBuild(root, options);
        expect(removed.hit).toBe(false);
        expect(removed.pending.inputs).toBeNull();
        expect(typeof (removed.pending as any).scan).toBe('function');
        await build();
        fs.appendFileSync(path.join(outDir, 'assets/main.js'), '\n// edited');
        expect(checkBuild(root, options).hit).toBe(false);
    });

    it('keeps builds with other options apart', async () => {
        await build();
        const other = { ...options, mode: 'development' };
        const check = checkBuild(root, other);
        expect(check.hit).toBe(false);
        expect(check.pending.inputs).toBeNull();
        expect(checkBuild(root, options).hit).toBe(true);
    });
});
