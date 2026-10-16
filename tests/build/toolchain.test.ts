/**
 * lunx's toolchain commands, run as a user runs them (dist/cli-fast.cjs):
 * `lunx test` (lunx's runner), `lunx run` (workspace tasks with a cache) and
 * `build.legacy` (nomodule scripts).
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bin = path.join(repo, 'dist', 'cli-fast.cjs');
const dirs: string[] = [];

function project(files: Record<string, string>, linkModules = true): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-toolchain-'));
    dirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    if (linkModules) fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
    return dir;
}

function lunx(cwd: string, ...args: string[]) {
    return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NO_COLOR: '1', LUNX_SKIP_SECURITY: '1', CI: '' } });
}

afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('lunx test', () => {
    const files = {
        'package.json': '{"name":"t","type":"module"}',
        'src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\nexport function unused() {\n  return 1;\n}\n',
        'src/sum.test.ts': [
            "import { describe, it, expect, vi } from 'vitest';",
            "import { sum } from './sum';",
            "describe('sum', () => {",
            "  it('adds', () => expect(sum(1, 2)).toBe(3));",
            "  it.each([[1, 1, 2], [2, 2, 4]])('%i + %i', (a, b, c) => expect(sum(a, b)).toBe(c));",
            "  it('equality and mocks', async () => {",
            "    expect({ a: [1, { b: 2 }], c: undefined }).toEqual({ a: [1, { b: 2 }] });",
            "    const f = vi.fn().mockReturnValueOnce(7);",
            "    expect(f()).toBe(7);",
            "    expect(f).toHaveBeenCalledTimes(1);",
            "    vi.useFakeTimers();",
            "    const p = new Promise((r) => setTimeout(() => r('late'), 5000));",
            "    vi.advanceTimersByTime(5000);",
            "    vi.useRealTimers();",
            "    await expect(p).resolves.toBe('late');",
            "  });",
            "  it('snapshots', () => {",
            "    expect({ z: 1, a: 'x' }).toMatchSnapshot();",
            "    expect([1, 2]).toMatchInlineSnapshot();",
            "  });",
            "  it.skip('skipped', () => {});",
            "});",
            '',
        ].join('\n'),
        'src/dom.test.ts': "// @vitest-environment jsdom\nimport { it, expect } from 'vitest';\nit('renders', () => {\n  document.body.innerHTML = '<p id=\"x\">hi</p>';\n  expect(document.getElementById('x')!.textContent).toBe('hi');\n});\n",
    };

    it('runs files in workers with snapshots, a DOM and coverage', () => {
        const dir = project(files);
        const r = lunx(dir, 'test', '--builtin', '--coverage');
        expect(r.stdout).toContain('Tests  6 passed | 1 skipped (7)');
        expect(r.status).toBe(0);
        expect(fs.readFileSync(path.join(dir, 'src/__snapshots__/sum.test.ts.snap'), 'utf8')).toContain('exports[`sum > snapshots 1`] = `\n{\n  "a": "x",\n  "z": 1,\n}\n`;');
        expect(fs.readFileSync(path.join(dir, 'src/sum.test.ts'), 'utf8')).toContain('toMatchInlineSnapshot(`\n      [\n        1,\n        2,\n      ]\n    `)');
        // `unused` never ran: its body line is uncovered.
        expect(r.stdout).toMatch(/src\/sum\.ts\s+\d+\.\d\s+3/);
        expect(fs.existsSync(path.join(dir, 'coverage/lcov.info'))).toBe(true);
        // A second run reads the snapshots it wrote.
        expect(lunx(dir, 'test', '--builtin').stdout).toContain('Tests  6 passed | 1 skipped (7)');
    }, 120_000);

    it('fails with a diff, and filters by test name', () => {
        const dir = project({
            'package.json': '{"name":"t","type":"module"}',
            'a.test.js': "import { it, expect } from 'vitest';\nit('one', () => expect({ n: 1 }).toEqual({ n: 2 }));\nit('two', () => expect(2).toBe(2));\n",
        });
        const failed = lunx(dir, 'test', '--builtin');
        expect(failed.status).toBe(1);
        expect(failed.stdout).toContain('FAIL one');
        expect(failed.stdout).toMatch(/-\s+n: 2,?\n\s+\+\s+n: 1/);
        const filtered = lunx(dir, 'test', '--builtin', '-t', 'two');
        expect(filtered.status).toBe(0);
        expect(filtered.stdout).toContain('Tests  1 passed | 1 skipped (2)');
    }, 120_000);
});

describe('lunx run', () => {
    it('runs workspace scripts in dependency order, then from its cache', () => {
        const write = (out: string, text: string) => `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/${out}','${text}');console.log('built ${out}')"`;
        const dir = project({
            'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }),
            'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { lib: '*' }, scripts: { build: `node -e "console.log('lib built first:', require('fs').existsSync('../lib/dist/lib.txt'))"` } }),
            'packages/lib/package.json': JSON.stringify({ name: 'lib', scripts: { build: write('lib.txt', 'L') } }),
        }, false);
        const first = lunx(dir, 'run', 'build');
        expect(first.status).toBe(0);
        expect(first.stdout).toContain('app:build: lib built first: true');
        expect(first.stdout).toContain('2 tasks (0 cached, 2 ran)');
        fs.rmSync(path.join(dir, 'packages/lib/dist'), { recursive: true });
        const second = lunx(dir, 'run', 'build');
        expect(second.stdout).toContain('2 tasks (2 cached, 0 ran)');
        expect(second.stdout).toContain('lib:build: built lib.txt');
        expect(fs.readFileSync(path.join(dir, 'packages/lib/dist/lib.txt'), 'utf8')).toBe('L');
        fs.writeFileSync(path.join(dir, 'packages/lib/extra.txt'), 'changed');
        expect(lunx(dir, 'run', 'build', '--filter', 'lib').stdout).toContain('1 task (0 cached, 1 ran)');
    }, 120_000);
});

describe('build.legacy', () => {
    it('adds a nomodule ES2015 script beside each module entry', () => {
        const dir = project({
            'package.json': '{"name":"l","type":"module"}',
            'lunx.config.js': 'export default { build: { legacy: true } };\n',
            'index.html': '<!DOCTYPE html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>',
            'src/main.js': "const o = { a: { b: 1 } };\nconst v = o.a?.b ?? 0;\nimport('./lazy.js').then((m) => console.log(v, m.x));\n",
            'src/lazy.js': 'export const x = 2;\n',
        });
        const r = lunx(dir, 'build');
        expect(r.status).toBe(0);
        const html = fs.readFileSync(path.join(dir, 'dist/index.html'), 'utf8');
        const legacy = /<script nomodule crossorigin src="\/assets\/(main-legacy\.[\w-]+\.js)"/.exec(html)?.[1];
        expect(legacy).toBeTruthy();
        const code = fs.readFileSync(path.join(dir, 'dist/assets', legacy!), 'utf8');
        expect(code).not.toMatch(/\bimport\s*\(|\bexport\b|\?\?|\?\./);
        expect(code).toContain('console.log');
    }, 120_000);
});
