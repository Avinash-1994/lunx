/**
 * `lunx create`: every starter writes a project that installs from npm
 * (lunx-dev, no unpublished @lunx/* packages) and matches its options.
 * scripts/template-matrix.mjs installs, builds and opens each one.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { STARTERS, findStarter } from '../../src/create/starters.js';
import { writeStarter, validProjectName, lunxVersion } from '../../src/create/scaffold.js';
import { parseCreateArgs } from '../../src/create/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-create-'));

function scaffold(id: string, opts: { ts?: boolean; tailwind?: boolean } = {}) {
    const dir = path.join(tmp(), `app-${id}`);
    const files = writeStarter(findStarter(id)!, dir, { name: `app-${id}`, ts: opts.ts ?? true, tailwind: opts.tailwind ?? false });
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
    return { dir, files, pkg, read };
}

describe('starters', () => {
    it.each(STARTERS.map((s) => s.id))('%s depends on published packages only', (id) => {
        const { pkg, files, read } = scaffold(id);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        expect(pkg.devDependencies['lunx-dev']).toBe(`^${lunxVersion()}`);
        expect(Object.keys(deps).filter((d) => d === 'lunx' || d.startsWith('@lunx/'))).toEqual([]);
        for (const [name, range] of Object.entries(deps)) expect([name, range]).not.toEqual([name, 'latest']);
        for (const file of files) {
            if (/\.(m?[jt]sx?|vue|svelte|astro|marko|md|html)$/.test(file)) {
                const text = read(file);
                expect([file, /from ['"]lunx['"]|@lunx\/plugin/.test(text)]).toEqual([file, false]);
            }
        }
        expect(pkg.scripts.build).toMatch(/^lunx /);
        expect(files).toContain('.gitignore');
        expect(files).toContain('README.md');
    });

    it('JavaScript variants have no TypeScript', () => {
        for (const starter of STARTERS.filter((s) => s.js)) {
            const { files, pkg } = scaffold(starter.id, { ts: false });
            expect([starter.id, files.filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))]).toEqual([starter.id, []]);
            expect([starter.id, files.includes('tsconfig.json'), 'typescript' in (pkg.devDependencies ?? {})]).toEqual([starter.id, false, false]);
        }
    });

    it('Tailwind adds the PostCSS plugin and its entry', () => {
        const { files, pkg, read } = scaffold('react', { tailwind: true });
        expect(files).toContain('postcss.config.mjs');
        expect(pkg.devDependencies).toMatchObject({ tailwindcss: expect.any(String), '@tailwindcss/postcss': expect.any(String) });
        expect(read('src/index.css')).toContain('@import "tailwindcss";');
        // Starters without a stylesheet to extend ignore it.
        expect(scaffold('angular', { tailwind: true }).files).not.toContain('postcss.config.mjs');
    });

    it('a library is a publishable package', () => {
        const { pkg } = scaffold('library');
        expect(pkg.private).toBeUndefined();
        expect(pkg.exports['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' });
        expect(pkg.scripts.build).toBe('lunx build --lib');
    });

    it('earlier template ids still work', () => {
        expect(findStarter('react-spa')?.id).toBe('react');
        expect(findStarter('vue-ts')?.id).toBe('vue');
        expect(findStarter('react-router-v7-app')?.id).toBe('react-router');
        expect(findStarter('nope')).toBeUndefined();
    });

    it('refuses a directory that is not empty', () => {
        const dir = tmp();
        fs.writeFileSync(path.join(dir, 'x'), '');
        expect(() => writeStarter(findStarter('react')!, dir, { name: 'x', ts: true, tailwind: false })).toThrow(/not empty/);
    });
});

describe('project names and flags', () => {
    it('validates names like npm', () => {
        expect(validProjectName('my-app')).toBeNull();
        expect(validProjectName('My App')).not.toBeNull();
        expect(validProjectName("x'; process.exit()")).not.toBeNull();
    });

    it('parses create-lunx arguments', () => {
        expect(parseCreateArgs(['my-app', '--template', 'vue', '--no-ts', '--tailwind'])).toEqual({ name: 'my-app', options: { template: 'vue', ts: false, tailwind: true } });
        expect(parseCreateArgs(['--template=svelte', 'app'])).toEqual({ name: 'app', options: { template: 'svelte' } });
        expect(() => parseCreateArgs(['--bogus'])).toThrow(/Unknown option/);
    });
});
