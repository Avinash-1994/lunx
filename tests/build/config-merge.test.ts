/**
 * A lunx.config next to a vite.config: the Vite config still applies under it
 * (its settings and plugins), lunx.config wins where both set something, and
 * a plugin listed in both runs once. Also: lunx-only keys (pwa, electron) pass
 * the config check.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dirs: string[] = [];

/** loadConfig as the CLI runs it, in Node: Jest's module VM cannot evaluate a vite.config. */
function loadConfig(root: string): any {
    const dist = pathToFileURL(path.join(repo, 'dist', 'config', 'index.js')).href;
    const script = `const { loadConfig } = await import(${JSON.stringify(dist)}); const c = await loadConfig(${JSON.stringify(root)});
console.log('@@' + JSON.stringify({ ...c, plugins: c.plugins?.map((p) => ({ name: p.name, from: p.from })), __vitePlugins: c.__vitePlugins?.map((p) => ({ name: p.name })) }));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const line = run.stdout.split('\n').find((l) => l.startsWith('@@'));
    if (!line) throw new Error(run.stdout + run.stderr);
    return JSON.parse(line.slice(2));
}

function project(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-config-merge-'));
    dirs.push(root);
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    for (const [rel, content] of Object.entries({ 'package.json': '{"type":"module"}', ...files })) fs.writeFileSync(path.join(root, rel), content);
    return root;
}

afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('lunx.config with a vite.config', () => {
    it('applies the Vite config underneath', () => {
        const root = project({
            'vite.config.mjs': [
                "import react from '@vitejs/plugin-react';",
                'export default {',
                "  plugins: [react(), { name: 'from-vite' }, { name: 'in-both', from: 'vite' }],",
                "  define: { __A__: '1', __B__: '1' },",
                "  server: { port: 4321, cors: true },",
                '};',
            ].join('\n'),
            'lunx.config.js': [
                'export default {',
                "  plugins: [{ name: 'in-both', from: 'lunx' }],",
                "  define: { __B__: '2' },",
                '  server: { cors: false },',
                "  pwa: { manifest: { name: 'Merged' } },",
                '  electron: false,',
                '};',
            ].join('\n'),
        });
        const config = loadConfig(root);
        expect(config.framework).toBe('react');
        expect(config.define).toEqual({ __A__: '1', __B__: '2' });
        expect(config.server).toMatchObject({ port: 4321, cors: false });
        expect(config.pwa).toEqual({ manifest: { name: 'Merged' } });
        expect(config.electron).toBe(false);
        expect(config.plugins.map((p: any) => [p.name, p.from])).toEqual([['in-both', 'lunx']]);
        expect(config.__vitePlugins.map((p: any) => p.name)).toEqual(['from-vite']);
    });

    it('is lunx.config alone without a vite.config', () => {
        const root = project({ 'lunx.config.js': "export default { define: { __X__: '1' } };\n" });
        const config = loadConfig(root);
        expect(config.define).toEqual({ __X__: '1' });
        expect(config.__vitePlugins).toBeUndefined();
    });
});
