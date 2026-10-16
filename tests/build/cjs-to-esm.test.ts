/**
 * Dependencies' static CommonJS modules become ES modules before bundling, so
 * unused exports drop (src/build/cjs-to-esm.ts). Anything that is not one of
 * the two static shapes is left to Rolldown's CommonJS interop.
 */
import { describe, it, expect } from '@jest/globals';
import { cjsToEsm, mayConvert } from '../../src/build/cjs-to-esm.js';

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
});
