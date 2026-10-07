/**
 * Library mode (src/build/library.ts): a TypeScript package with two
 * entries, a peer dependency kept external and a devDependency bundled.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const repoModules = path.resolve(process.cwd(), 'node_modules');
let root: string;

function write(file: string, content: string) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
}

// Rolldown checks plugin filters with native RegExp, which Jest's VM realm
// does not share, so the build runs in its own Node process.
function buildLibrary(options: Record<string, unknown>): { result: any; error: string } {
    const script = path.join(root, 'build.mts');
    const library = pathToFileURL(path.resolve(process.cwd(), 'src/build/library.ts')).href;
    fs.writeFileSync(script, `import { buildLibrary } from ${JSON.stringify(library)};
try {
    console.log(JSON.stringify(await buildLibrary(${JSON.stringify(root)}, ${JSON.stringify(options)})));
} catch (err) {
    console.log(JSON.stringify({ error: err.message }));
}
`);
    const run = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    const parsed = JSON.parse(run.stdout.trim().split('\n').pop() || '{}');
    return { result: parsed.error ? null : parsed, error: parsed.error ?? run.stderr };
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-lib-'));
    fs.symlinkSync(repoModules, path.join(root, 'node_modules'), 'dir');
    write('package.json', JSON.stringify({
        name: 'demo-lib',
        type: 'module',
        peerDependencies: { react: '^19.0.0' },
        devDependencies: { clsx: '^2.0.0' },
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js', require: './dist/index.cjs' }, './missing': './dist/missing.js' },
    }));
    write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'bundler', target: 'ES2022', skipLibCheck: true } }));
    write('src/index.ts', [
        "import clsx from 'clsx';",
        "import { version } from 'react';",
        "export { add } from './utils/math';",
        'export function classes(...names: string[]): string { return clsx(...names); }',
        'export const reactVersion: string = version;',
    ].join('\n'));
    write('src/utils/math.ts', 'export function add(a: number, b: number): number { return a + b; }\n');
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('library mode', () => {
    it('builds ES and CommonJS outputs with declarations', () => {
        const { result, error } = buildLibrary({ entry: { index: 'src/index.ts', math: 'src/utils/math.ts' } });
        expect(error).toBe('');
        const files = result.files.map((f: any) => f.file).sort();
        expect(files).toEqual(expect.arrayContaining(['index.js', 'index.cjs', 'math.js', 'math.cjs', 'index.d.ts', 'utils/math.d.ts', 'math.d.ts']));
        // The peer dependency stays an import; the devDependency is bundled.
        const esm = fs.readFileSync(path.join(root, 'dist/index.js'), 'utf8');
        expect(esm).toMatch(/from ["']react["']/);
        expect(esm).not.toMatch(/from ["']clsx["']/);
        expect(fs.readFileSync(path.join(root, 'dist/index.d.ts'), 'utf8')).toContain('export declare function classes(...names: string[]): string;');
        expect(fs.readFileSync(path.join(root, 'dist/math.d.ts'), 'utf8')).toBe('export * from "./utils/math";\n');
        // package.json fields pointing at files the build did not write.
        expect(result.problems).toEqual(['exports["./missing"] → ./dist/missing.js does not exist']);
    }, 60000);

    it('produces outputs that run in Node', () => {
        const probe = path.join(root, 'probe.cjs');
        fs.writeFileSync(probe, `
const cjs = require('./dist/index.cjs');
import('./dist/index.js').then((esm) => {
    console.log(JSON.stringify({ cjs: cjs.add(1, 2), esm: esm.classes('a', 'b'), react: esm.reactVersion.split('.')[0] }));
});
`);
        const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', cwd: root, env: { ...process.env, NODE_OPTIONS: '' } });
        expect(run.stderr).toBe('');
        expect(JSON.parse(run.stdout)).toEqual({ cjs: 3, esm: 'a b', react: '19' });
    }, 60000);

    it('builds a UMD bundle with a global name and rejects one without', () => {
        const { result } = buildLibrary({ entry: 'src/utils/math.ts', formats: ['umd'], name: 'DemoMath', dts: false });
        expect(result.files.map((f: any) => f.file)).toEqual(['math.umd.cjs']);
        const code = fs.readFileSync(path.join(root, 'dist/math.umd.cjs'), 'utf8');
        expect(code).toContain('DemoMath');
        const failed = buildLibrary({ entry: 'src/utils/math.ts', formats: ['umd'], dts: false });
        expect(failed.error).toMatch(/needs `name`/);
    }, 60000);
});
