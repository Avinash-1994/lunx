/**
 * esbuild plugins replayed on Rolldown (src/plugin-host/esbuild-plugins.ts):
 * a virtual namespace, a custom loader, resolveDir and the lifecycle hooks.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { esbuildPluginsToRolldown } from '../../src/plugin-host/esbuild-plugins.js';
import { requireEsm } from '../../src/engines/require-esm.js';

// Rolldown loaded by Node itself: in Jest's VM realm its native option checks reject the realm's objects.
const { rolldown } = requireEsm('rolldown');

let root: string;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-esbuild-plugin-'));
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'main.js'), [
        "import env from 'env:config';",
        "import greeting from './hello.txt';",
        "import { twice } from 'virtual-math';",
        'export const out = env.MODE + " " + greeting + " " + twice(21);',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'hello.txt'), 'hello');
    fs.writeFileSync(path.join(root, 'lib', 'double.js'), 'export const double = (n) => n * 2;\n');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('esbuild plugins on Rolldown', () => {
    it('runs onResolve / onLoad with namespaces, loaders and resolveDir', async () => {
        const events: string[] = [];
        const plugin = {
            name: 'test-plugin',
            setup(build: any) {
                build.onStart(() => { events.push('start'); });
                build.onEnd(() => { events.push('end'); });
                build.onResolve({ filter: /^env:/ }, (args: any) => ({ path: args.path.slice(4), namespace: 'env' }));
                build.onLoad({ filter: /.*/, namespace: 'env' }, () => ({ contents: JSON.stringify({ MODE: 'test' }), loader: 'json' }));
                build.onLoad({ filter: /\.txt$/ }, (args: any) => ({ contents: fs.readFileSync(args.path, 'utf8').toUpperCase(), loader: 'text' }));
                build.onResolve({ filter: /^virtual-math$/ }, () => ({ path: 'math', namespace: 'virtual' }));
                // Relative imports of a namespaced module resolve from the resolveDir it was given.
                build.onLoad({ filter: /^math$/, namespace: 'virtual' }, () => ({
                    contents: "import { double } from './double.js'; export const twice = double;",
                    resolveDir: path.join(root, 'lib'),
                }));
            },
        };
        const bundle = await rolldown({
            input: path.join(root, 'main.js'),
            cwd: root,
            platform: 'browser',
            logLevel: 'silent',
            plugins: esbuildPluginsToRolldown([plugin], { root, platform: 'browser' }),
        });
        const { output } = await bundle.generate({ format: 'es' });
        await bundle.close();
        const code = output[0].code as string;
        const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
        const mod = await import(url);
        expect(mod.out).toBe('test HELLO 42');
        expect(events).toEqual(['start', 'end']);
    }, 30000);
});
