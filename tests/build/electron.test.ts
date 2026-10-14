/**
 * Electron apps without a plugin: lunx finds electron/main and electron/preload,
 * and builds them for Node into dist-electron/ (the main process as the
 * package's module type with its runtime dependencies left to node_modules,
 * the preload as one CommonJS file a sandboxed renderer can run).
 * scripts/template-matrix.mjs runs the starter in Electron, in dev and preview.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveElectron } from '../../src/electron/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let root: string;

/** Built as `lunx build` does, in Node (Rolldown's bindings reject Jest's VM realm). */
function buildElectron(): string[] {
    const dist = pathToFileURL(path.join(repo, 'dist', 'electron', 'index.js')).href;
    const script = `const m = await import(${JSON.stringify(dist)}); console.log(JSON.stringify(await m.buildElectron(m.resolveElectron(${JSON.stringify(root)}, {}))));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return JSON.parse(run.stdout.trim().split('\n').pop()!);
}

function write(file: string, content: string) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-electron-'));
    write('package.json', JSON.stringify({ type: 'module', main: 'dist-electron/main.js', dependencies: { 'runtime-dep': '1.0.0' }, devDependencies: { electron: '^44.0.0' } }));
    write('electron/main.ts', [
        "import { app } from 'electron';",
        "import path from 'node:path';",
        "import dep from 'runtime-dep';",
        "import { title } from './title';",
        'const size: number = 2;',
        'app.whenReady().then(() => console.log(title, size, dep, path.sep));',
    ].join('\n'));
    write('electron/title.ts', "export const title = 'from a local module';");
    write('electron/preload.ts', "import { contextBridge } from 'electron';\nimport { greeting } from '../src/shared';\ncontextBridge.exposeInMainWorld('api', { greeting });");
    write('src/shared.ts', "export const greeting = 'hello from shared';");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Electron', () => {
    it('finds the entries in electron/', () => {
        const app = resolveElectron(root, {})!;
        expect(app.main).toBe(path.join(root, 'electron/main.ts'));
        expect(app.preload).toBe(path.join(root, 'electron/preload.ts'));
        expect(app.outDir).toBe(path.join(root, 'dist-electron'));
        expect(app.esm).toBe(true);
    });

    it('takes entries from config, and steps aside for electron: false or vite-plugin-electron', () => {
        const app = resolveElectron(root, { electron: { main: 'electron/title.ts', preload: false, outDir: 'out/electron' } })!;
        expect(app.main).toBe(path.join(root, 'electron/title.ts'));
        expect(app.preload).toBeUndefined();
        expect(app.outDir).toBe(path.join(root, 'out/electron'));
        expect(resolveElectron(root, { electron: false })).toBeNull();
        expect(resolveElectron(root, { plugins: [[{ name: 'vite-plugin-electron' }]] })).toBeNull();
    });

    it('is not an Electron app without electron installed', () => {
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-not-electron-'));
        try {
            fs.writeFileSync(path.join(other, 'package.json'), '{"dependencies":{"react":"19.0.0"}}');
            fs.mkdirSync(path.join(other, 'electron'));
            fs.writeFileSync(path.join(other, 'electron/main.js'), '');
            expect(resolveElectron(other, {})).toBeNull();
        } finally {
            fs.rmSync(other, { recursive: true, force: true });
        }
    });

    it('builds the main process and the preload', () => {
        fs.mkdirSync(path.join(root, 'dist-electron'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dist-electron/stale.js'), '');
        const files = buildElectron();
        expect(files.sort()).toEqual(['dist-electron/main.js', 'dist-electron/preload.cjs']);
        expect(fs.existsSync(path.join(root, 'dist-electron/stale.js'))).toBe(false);

        const main = fs.readFileSync(path.join(root, 'dist-electron/main.js'), 'utf8');
        expect(main).toMatch(/from "electron"/);
        expect(main).toMatch(/from "runtime-dep"/); // left to node_modules
        expect(main).toContain('from a local module'); // bundled
        expect(main).not.toMatch(/: number/);

        const preload = fs.readFileSync(path.join(root, 'dist-electron/preload.cjs'), 'utf8');
        expect(preload).toMatch(/require\("electron"\)/);
        expect(preload).toContain('hello from shared');
        expect(preload).not.toMatch(/^import |^export /m);
    });

    it('writes CommonJS for a CommonJS package', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ ...pkg, type: undefined }));
        try {
            buildElectron();
            const main = fs.readFileSync(path.join(root, 'dist-electron/main.js'), 'utf8');
            expect(main).toMatch(/require\("electron"\)/);
            expect(main).not.toMatch(/^import /m);
        } finally {
            fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
        }
    });
});
