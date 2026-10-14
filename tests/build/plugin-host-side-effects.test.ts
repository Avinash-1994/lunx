/**
 * The plugin host's resolver (Vite's `vite:resolve` stand-in, used by
 * SvelteKit, Nuxt, Qwik City…) reports each module's package.json
 * `sideEffects`, as Vite does: Rolldown does not look it up for ids a plugin
 * resolved, and without it a `sideEffects: false` package's unused modules
 * stayed in the client bundle (scripts/meta-parity.mjs found Nuxt's client
 * 23% larger than nuxt's own build).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolvePlugin } from '../../src/plugin-host/plugins/resolve.js';

let root: string;

function write(rel: string, content: string) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
}

beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-side-effects-')));
    write('package.json', '{"name":"app","type":"module"}');
    write('src/main.js', '');
    write('node_modules/pure/package.json', '{"name":"pure","sideEffects":false,"main":"index.js"}');
    write('node_modules/pure/index.js', "export * from './lib/a.js';");
    write('node_modules/pure/lib/a.js', 'export const a = 1;');
    write('node_modules/pure/lib/package.json', '{"type":"module"}'); // a nested manifest without a name
    write('node_modules/styled/package.json', '{"name":"styled","sideEffects":["*.css","./setup.js"],"main":"index.js"}');
    write('node_modules/styled/index.js', '');
    write('node_modules/styled/theme.css', '');
    write('node_modules/styled/setup.js', '');
    write('node_modules/plain/package.json', '{"name":"plain","main":"index.js"}');
    write('node_modules/plain/index.js', '');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function resolver() {
    const plugin = resolvePlugin({ root, command: 'build', resolve: { conditions: [], mainFields: ['module'], extensions: ['.mjs', '.js', '.json'], preserveSymlinks: false } });
    const ctx = { environment: { config: { consumer: 'client', resolve: { conditions: [], mainFields: ['module'], extensions: ['.mjs', '.js', '.json'], preserveSymlinks: false } } } };
    return (id: string, importer = path.join(root, 'src/main.js')) => plugin.resolveId.call(ctx, id, importer, {});
}

describe('plugin host resolver: package sideEffects', () => {
    it('marks modules of a sideEffects: false package, relative imports and nested manifests included', async () => {
        const resolve = resolver();
        expect(await resolve('pure')).toEqual({ id: path.join(root, 'node_modules/pure/index.js'), moduleSideEffects: false });
        expect(await resolve('./lib/a.js', path.join(root, 'node_modules/pure/index.js'))).toEqual({ id: path.join(root, 'node_modules/pure/lib/a.js'), moduleSideEffects: false });
    });

    it('follows a sideEffects list (a pattern without "/" matches the file name anywhere)', async () => {
        const resolve = resolver();
        const from = path.join(root, 'node_modules/styled/index.js');
        expect(await resolve('styled')).toEqual({ id: from, moduleSideEffects: false });
        expect(await resolve('./theme.css', from)).toEqual({ id: path.join(root, 'node_modules/styled/theme.css'), moduleSideEffects: true });
        expect(await resolve('./setup.js', from)).toEqual({ id: path.join(root, 'node_modules/styled/setup.js'), moduleSideEffects: true });
    });

    it('leaves packages without sideEffects as they are', async () => {
        expect(await resolver()('plain')).toBe(path.join(root, 'node_modules/plain/index.js'));
    });
});
