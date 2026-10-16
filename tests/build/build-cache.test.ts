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
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
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

    it('restores a removed output from its snapshot, and rebuilds an output edited in place', async () => {
        await build();
        const main = path.join(outDir, 'assets/main.js');
        const built = fs.readFileSync(main, 'utf8');
        fs.rmSync(outDir, { recursive: true });
        expect(checkBuild(root, options)).toMatchObject({ hit: true, restored: true });
        expect(fs.readFileSync(main, 'utf8')).toBe(built);
        expect(checkBuild(root, options)).toMatchObject({ hit: true, restored: false });
        fs.appendFileSync(main, '\n// edited'); // the snapshot shares the file: it no longer matches either
        expect(checkBuild(root, options).hit).toBe(false);
    });

    it('restores nothing when an input changed too', async () => {
        await build();
        write('src/main.ts', 'console.log(333);');
        fs.rmSync(outDir, { recursive: true });
        expect(checkBuild(root, options).hit).toBe(false);
        expect(fs.existsSync(outDir)).toBe(false);
    });

    it('reads the inputs during the build when nothing was built with these options', async () => {
        const first = checkBuild(root, options);
        expect(first.hit).toBe(false);
        expect(first.pending.inputs).toBeNull();
        expect(typeof (first.pending as any).scan).toBe('function');
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

describe('lunx build, before lunx loads (cli-fast)', () => {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/cli-fast.cjs');
    const lunx = (...args: string[]) => {
        const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', LUNX_SKIP_SECURITY: '1', NO_COLOR: '1' };
        delete env.LUNX_BUILD_CACHE;
        const r = spawnSync(process.execPath, [bin, 'build', '--root', root, ...args], { encoding: 'utf8', env });
        if (r.status !== 0) throw new Error(r.stdout + r.stderr);
        return r.stdout;
    };

    it('answers an unchanged build and restores a removed output; rebuilds after a change or with --force', () => {
        write('index.html', '<!DOCTYPE html><html><body><script type="module" src="/src/main.ts"></script></body></html>');
        write('package.json', '{"type":"module"}');
        expect(lunx()).toContain('built in');
        expect(lunx()).toContain('Up to date: nothing changed since the last build');
        fs.rmSync(outDir, { recursive: true });
        expect(lunx()).toContain('restored from the build cache');
        expect(fs.readdirSync(path.join(outDir, 'assets')).some((f) => f.endsWith('.js'))).toBe(true);
        expect(lunx('--force')).toContain('built in');
        expect(lunx()).toContain('Up to date'); // --force is not part of what the next build matches
        write('src/main.ts', 'console.log(2);');
        expect(lunx()).toContain('built in');
    }, 60_000);
});
