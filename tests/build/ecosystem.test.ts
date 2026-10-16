/**
 * Ecosystem features (reports/BUILD_TOOL_LANDSCAPE.md §9 P4): WebAssembly ESM
 * imports, module federation runtime APIs, the React Compiler setting.
 * Chromium checks: scripts/federation-e2e.mjs, scripts/library-conformance.mjs.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { wasmEsmModule } from '../../src/build/wasm-init.js';
import { normalizeRemotes } from '../../src/federation/engine.js';
import { runtimeSource } from '../../src/federation/runtime-source.js';
import { reactCompiler } from '../../src/core/react-compiler.js';

// (func (export "add") (param i32 i32) (result i32))
const ADD = Buffer.from('0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b', 'hex');
// imports "./env.js" "double", exports "quad"
const QUAD = Buffer.from('0061736d010000000106016001' + '7f017f' + '021301082e2f656e762e6a7306646f75626c650000' + '03020100' + '07080104717561640001' + '0a0a010800200010001000' + '0b', 'hex');

describe('WebAssembly ESM imports', () => {
    it('exports what the module exports, and imports what its import section names', () => {
        const add = wasmEsmModule(ADD, '"/add.wasm"');
        expect(add).toContain('export { __wasm_export_0 as "add" };');
        expect(add).toContain('export default url;');
        const quad = wasmEsmModule(QUAD, '"/quad.wasm"');
        expect(quad).toContain('import * as __wasm_import_0 from "./env.js";');
        expect(quad).toContain('"./env.js": __wasm_import_0');
        expect(quad).toContain('as "quad"');
    });
});

describe('module federation runtime', () => {
    it('takes remotes as strings or { entry, name, type }', () => {
        expect(normalizeRemotes({
            a: 'http://a.test/remoteEntry.js',
            b: { entry: 'http://b.test/remoteEntry.js' },
            c: { entry: 'http://c.test/remoteEntry.js', type: 'script' },
            d: { entry: 'http://d.test/remoteEntry.js', name: 'dglobal' },
        })).toEqual({
            a: 'http://a.test/remoteEntry.js',
            b: 'http://b.test/remoteEntry.js',
            c: 'c@http://c.test/remoteEntry.js',
            d: 'dglobal@http://d.test/remoteEntry.js',
        });
    });

    it('carries registerRemotes, registerPlugins, the share strategy and plugin imports', () => {
        const code = runtimeSource('host', {}, {}, undefined, { shareStrategy: 'version-first', plugins: ['/abs/plugin.js'] });
        expect(code).toContain('import __mf_plugin_0 from "/abs/plugin.js";');
        expect(code).toContain('const STRATEGY = "version-first";');
        expect(code).toContain('export function registerRemotes(');
        expect(code).toContain('export function registerPlugins(');
        expect(code).toContain('errorLoadRemote');
    });

    it('does not register its own copy of a shared package with import: false', () => {
        const code = runtimeSource('host', { react: { version: '19.0.0', requiredVersion: '^19.0.0', singleton: true, strictVersion: false, eager: false, import: false } }, {});
        expect(code).not.toMatch(/"react": \(\) => import/);
        expect(code).toContain('s.import !== false');
    });
});

describe('React Compiler setting', () => {
    it('is off without the plugin, and says what to install when asked for', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-rc-'));
        try {
            fs.writeFileSync(path.join(root, 'package.json'), '{"name":"app"}');
            expect(reactCompiler(root, undefined)).toBeNull();
            expect(reactCompiler(root, { compiler: false })).toBeNull();
            expect(() => reactCompiler(root, { compiler: true })).toThrow(/babel-plugin-react-compiler/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('Vite-based tools on lunx (lunx exec)', () => {
    it('fetchModule externalizes builtins and URLs as Vite does', async () => {
        const { fetchModule } = await import('../../src/plugin-host/shim.js');
        expect(await fetchModule({}, 'node:fs')).toEqual({ externalize: 'node:fs', type: 'builtin' });
        expect(await fetchModule({}, 'path')).toEqual({ externalize: 'path', type: 'builtin' });
        expect(await fetchModule({}, 'https://cdn.test/x.js')).toEqual({ externalize: 'https://cdn.test/x.js', type: 'network' });
    });
});
