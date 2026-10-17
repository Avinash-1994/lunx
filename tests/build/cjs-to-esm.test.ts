/**
 * Dependencies' static CommonJS modules become ES modules before bundling, so
 * unused exports drop (src/build/cjs-to-esm.ts). Anything that is not one of
 * the two static shapes is left to Rolldown's CommonJS interop.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cjsToEsm, cjsToEsmByTree, exportsModuleByLexer, mayConvert } from '../../src/build/cjs-to-esm.js';
import { lexExportsModule, lexExportsModuleJs } from '../../src/build/cjs-lexer.js';
import { loadNativeBinding } from '../../src/native/binding.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('CommonJS to ES modules', () => {
    it('turns exports.name assignments into exported variables, and top-level requires into namespace imports', () => {
        const code = '"use strict";\nvar dep = require("dep");\nfunction a() { return dep.x + exports.b; }\nexports.a = a;\nif (cond) { exports.b = 1; } else { exports.b = 2; }\n';
        const out = cjsToEsm(code, 'm.js', 'production')!;
        expect(out).toContain('import * as dep from "dep";');
        expect(out).toContain('__exp_a = a;');
        expect(out).toContain('return dep.x + __exp_b;');
        expect(out).toMatch(/export \{ (__exp_b as b, __exp_a as a|__exp_a as a, __exp_b as b) \};/);
        expect(out).toMatch(/export default \{ .*"a": __exp_a.* \};/);
        expect(out.split('\n')[3]).toBe('__exp_a = a;'); // lines keep their numbers
    });

    it("re-exports the build mode's branch of an entry module, keeping local calls", () => {
        const entry = "'use strict';\nfunction check() {}\nif (process.env.NODE_ENV === 'production') {\n  check();\n  module.exports = require('./cjs/x.production.js');\n} else {\n  module.exports = require('./cjs/x.development.js');\n}\n";
        expect(cjsToEsm(entry, 'index.js', 'production')).toBe('export * from "./cjs/x.production.js";\nexport { default } from "./cjs/x.production.js";\nfunction check() {}\ncheck();\n');
        expect(cjsToEsm(entry, 'index.js', 'development')).toContain('export * from "./cjs/x.development.js";');
    });

    it('leaves dynamic modules alone', () => {
        const dynamic = [
            'module.exports = function () {};',
            'exports[name] = 1;',
            'if (typeof exports === "object") exports.a = 1;',
            'var a = 1; var dep = require("dep"); exports.a = dep;', // a require after other code
            'function f() { return require("lazy"); } exports.f = f;',
            'var dep = require("dep"); dep = null; exports.a = 1;',
            'exports.default = 1;',
            'exports.a = this;',
        ];
        for (const code of dynamic) expect(cjsToEsm(code, 'm.js', 'production')).toBeNull();
        expect(mayConvert('import x from "y"; exports.a = 1;')).toBe(false);
    });

    it('the lexer (large modules) converts as the syntax tree does, or defers to it', () => {
        // React's builds: converted by the lexer, the same output.
        for (const rel of ['react-dom/cjs/react-dom-client.production.js', 'react/cjs/react.production.js', 'scheduler/cjs/scheduler.production.js']) {
            const code = fs.readFileSync(path.join(repo, 'node_modules', rel), 'utf8');
            const lexed = exportsModuleByLexer(code);
            expect(lexed).toBeTruthy();
            expect(lexed).toBe(cjsToEsmByTree(code, rel, 'production'));
        }
        const pad = '\n' + '// padding\n'.repeat(4000); // above the lexer's size threshold
        const cases: Array<[string, 'same' | 'unsure']> = [
            // Regular expressions, division, templates, comments: no false `exports`.
            ['var d = require("d");\nexports.a = /exports\\.x/.test(s) ? 1 / 2 : `exports.${"y"}`; // exports.z\n', 'same'],
            ['exports.f = function (a) { return a ? { exports: 1 } : (b) / 2; };\nexports.g = (x) => x++ / 2;\n', 'same'],
            // A label's block and a case's block before a regular expression.
            ['exports.h = function () { a: { if (x) break a; } /re/.test(y); switch (k) { case 1: { break; } } };\n', 'same'],
            // `this` in a function is fine; at the top level, in an arrow or a method, the tree decides.
            ['exports.i = function () { return this; };\n', 'same'],
            ['exports.j = () => this;\n', 'unsure'],
            ['exports.k = { m() { return this; } };\n', 'unsure'],
            // A namespace declared again: the tree tells nested from top-level.
            ['var React = require("react");\nfunction f() { var a, React; return React; }\nexports.f = f;\n', 'unsure'],
            // Dynamic shapes: null either way.
            ['exports[name] = 1;\n', 'same'],
            ['var dep = require("dep");\ndep = null;\nexports.a = 1;\n', 'same'],
            ['module.exports = { a: 1 };\n', 'same'],
        ];
        for (const [code, expected] of cases) {
            const big = code + pad;
            const lexed = exportsModuleByLexer(big);
            const tree = cjsToEsmByTree(big, 'm.js', 'production');
            if (expected === 'unsure') expect(lexed).toBeUndefined();
            else expect(lexed).toBe(tree);
            // Whichever path runs, cjsToEsm gives the tree's answer.
            expect(cjsToEsm(big, 'm.js', 'production')).toBe(tree);
        }
    });

    it('the native lexer (when the binding has it) decides as the JavaScript one, to the offset', () => {
        const pad = '\n' + '// padding\n'.repeat(4000);
        const sources = [
            ...['react-dom/cjs/react-dom-client.production.js', 'react/cjs/react.production.js', 'scheduler/cjs/scheduler.production.js', 'react/cjs/react-jsx-runtime.development.js'].map((rel) =>
                fs.readFileSync(path.join(repo, 'node_modules', rel), 'utf8'),
            ),
            // Non-ASCII in strings and comments: offsets are UTF-16 indexes.
            'var a = require("a");\nvar s = "héllo 😀 ✓"; // ünïcode\nexports.x = `😀${s}`;\nexports.y = /é/.test(s);\n',
            'exports.a = 1;\nexports.b = function () { return "😀"; };\nmodule.exports.c = 2;\n',
            'var x = require("x"), y = require("y");\nexports.z = x.a + y.b;\n',
            'exports.e = é;\n', // a non-ASCII identifier: unsure
            '"use strict";\nexports.__esModule = true;\n',
            'exports.q = a ? { exports: 1 } : b; exports.r = c ?. d; exports.t = `a${`b${c}`}`;\n',
            'var React = require("react");\nvar { React: R } = z;\nexports.f = R;\n',
            'class A { m() { return 1; } }\nexports.A = A;\nfor (const k of o) exports[k] = 1;\n',
            'exports.u = "unterminated',
        ];
        for (const src of sources) {
            for (const code of [src, src + pad]) expect(lexExportsModule(code)).toEqual(lexExportsModuleJs(code));
        }
        if (loadNativeBinding().binding?.lexCjsExports) expect(lexExportsModule('exports.a = 1;')).toEqual({ requires: [], exportRefs: [{ start: 0, end: 9, name: 'a' }] });
    });

    it('treats an arrow function at the top level as the module scope for `this`', () => {
        expect(cjsToEsm('exports.a = () => this;', 'm.js', 'production')).toBeNull();
        expect(cjsToEsm('exports.a = function () { return this; };', 'm.js', 'production')).not.toBeNull();
    });
});
