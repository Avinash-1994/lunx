/**
 * Oxc compile: TypeScript's `useDefineForClassFields: false` (classFields:
 * 'assign') for decorated reactive properties (Lit), the private-member
 * helpers that lowering needs, and code compiled twice.
 */
import { describe, it, expect } from '@jest/globals';
import { compile } from '../../src/engines/index.js';

const run = (code: string) => new Function(`${code.replace(/^export \{[^}]*\};?$/gm, '').replace(/^export /gm, '')}\nreturn Counter;`)();

const SOURCE = `
function track(target: any, key: string) {
    (target.constructor.tracked ??= []).push(key);
}
export class Counter {
    @track count: number = 1;
    declare label: string;
    unset?: number;
    #step = 2;
    static #made = 0;
    constructor() { Counter.#made++; }
    get #double() { return this.count * 2; }
    bump() { this.count += this.#step; return this.#double; }
    has(o: object) { return #step in o; }
    static made() { return Counter.#made; }
}`;

describe('classFields: assign', () => {
    it('assigns fields in the constructor and drops fields without an initializer', () => {
        const { code } = compile('counter.ts', SOURCE, { legacyDecorators: true, classFields: 'assign' });
        expect(code).toContain('this.count = 1');
        expect(code).not.toMatch(/\bunset\b/);
        expect(code).not.toMatch(/\blabel\b/);
    });

    it('runs: decorators, private fields, accessors, `in`, statics', () => {
        const Counter = run(compile('counter.ts', SOURCE, { legacyDecorators: true, classFields: 'assign' }).code);
        const c = new Counter();
        expect(Counter.tracked).toEqual(['count']);
        expect(c.bump()).toBe(6);
        expect(c.has(c)).toBe(true);
        expect(c.has({})).toBe(false);
        new Counter();
        expect(Counter.made()).toBe(2);
        // Assigned, not defined: an accessor on the prototype is not shadowed by an own field.
        expect(Object.getOwnPropertyDescriptor(c, 'unset')).toBeUndefined();
    });

    it('declares the helpers once when code is compiled again', () => {
        const once = compile('counter.ts', SOURCE, { legacyDecorators: true, classFields: 'assign' }).code;
        const twice = compile('counter.js', once, {}).code;
        expect(twice.match(/const babelHelpers =/g)).toHaveLength(1);
        expect(run(twice)).toBeTruthy();
    });
});
