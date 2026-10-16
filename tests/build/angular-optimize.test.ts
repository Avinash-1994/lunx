/**
 * Angular's build optimizations (src/build/angular/optimize.ts), as `ng build`
 * runs them on Angular packages: what makes unused components, services and
 * metadata tree-shake out of an ahead-of-time build.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as babel from '@babel/core';
import { adjustStaticMembers, adjustTypeScriptEnums, elideAngularMetadata, markTopLevelPure } from '../../src/build/angular/optimize.js';
import { prepareAngularAot } from '../../src/build/angular/aot.js';

const run = (code: string, plugins: any[]) =>
    babel.transformSync(code, { filename: 'x.mjs', plugins, babelrc: false, configFile: false, compact: false })!.code!;

describe('Angular build optimizations', () => {
    it('wraps a class with Angular static members in a pure IIFE', () => {
        const out = run('class Foo {}\nFoo.ɵfac = function Foo_Factory() { return new Foo(); };\nFoo.ɵprov = ɵɵdefineInjectable({ token: Foo });\nexport { Foo };', [[adjustStaticMembers, { wrapDecorators: false }]]);
        expect(out).toMatch(/let Foo = \/\*#__PURE__\*\/\(\(\) => \{/);
        expect(out).toContain('return Foo;');
        expect(out).toContain('Foo.ɵprov');
    });

    it('marks top-level calls pure, only `new InjectionToken` in safe mode', () => {
        const code = 'const a = make();\nconst T = new InjectionToken("t");';
        const full = run(code, [[markTopLevelPure, { topLevelSafeMode: false }]]);
        expect(full).toMatch(/\/\*#__PURE__\*\/make\(\)/);
        const safe = run(code, [[markTopLevelPure, { topLevelSafeMode: true }]]);
        expect(safe).not.toMatch(/__PURE__\*\/make/);
        expect(safe).toMatch(/\/\*#__PURE__\*\/new InjectionToken/);
    });

    it('drops TestBed / dev tools metadata', () => {
        const out = run('(function () { ɵsetClassMetadata(Foo, [], null, null); })();', [elideAngularMetadata]);
        expect(out).not.toContain('ɵsetClassMetadata(');
        expect(out).toContain('void 0');
    });

    it('turns a TypeScript enum into a pure IIFE', () => {
        const out = run('var Color;\n(function (Color) {\n  Color[Color["Red"] = 0] = "Red";\n})(Color || (Color = {}));', [adjustTypeScriptEnums]);
        expect(out).toMatch(/var Color = \/\*#__PURE__\*\/function \(Color\) \{/);
        expect(out).toContain('return Color;');
    });
});

describe('Angular AOT', () => {
    it('is skipped (JIT build) without @angular/compiler-cli', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-ng-'));
        try {
            fs.writeFileSync(path.join(root, 'package.json'), '{"name":"app"}');
            const aot = await prepareAngularAot({ root, from: root, entries: [], sourcemap: false, compileStyle: async (_f, s) => s });
            expect(aot).toBeNull();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
