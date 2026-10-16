/**
 * The test API of `lunx test`, as Vitest's and Jest's: `describe`, `it` /
 * `test` (with `.skip`, `.only`, `.todo`, `.each`), hooks, `expect`, `vi`.
 * Test files may import it from 'lunx-dev/test' or use the globals.
 */

import { expect } from './expect.js';
import { vi } from './mock.js';

export type TestFn = (done?: (err?: unknown) => void) => void | Promise<void>;
type Mode = 'run' | 'skip' | 'only' | 'todo';

export interface TestCase {
    name: string;
    fn: TestFn | null;
    mode: Mode;
    timeout: number;
    suite: Suite;
}

export interface Suite {
    name: string;
    parent: Suite | null;
    mode: Mode;
    children: Array<Suite | TestCase>;
    beforeAll: TestFn[];
    afterAll: TestFn[];
    beforeEach: TestFn[];
    afterEach: TestFn[];
}

export const DEFAULT_TIMEOUT = 5000;

const newSuite = (name: string, parent: Suite | null, mode: Mode): Suite => ({ name, parent, mode, children: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] });

let root = newSuite('', null, 'run');
let currentSuite = root;

/** A fresh tree for the next test file; returns the previous one. */
export function takeRoot(): Suite {
    const done = root;
    root = newSuite('', null, 'run');
    currentSuite = root;
    return done;
}

function format(name: string, row: unknown[], index: number): string {
    let i = 0;
    let out = name.replace(/%[sdifjo%]/g, (m) => {
        if (m === '%%') return '%';
        const v = row[i++];
        if (m === '%d' || m === '%i') return String(Math.trunc(Number(v)));
        if (m === '%f') return String(Number(v));
        if (m === '%j' || m === '%o') return JSON.stringify(v);
        return String(v);
    });
    const obj = row.length === 1 && row[0] && typeof row[0] === 'object' ? (row[0] as Record<string, unknown>) : null;
    if (obj) out = out.replace(/\$([\w.]+)/g, (m, key: string) => (key.split('.').reduce<any>((o, k) => o?.[k], obj) ?? m) as string);
    return out.replace(/\$#/g, String(index));
}

function each(register: (name: string, fn: any, timeout?: number) => void) {
    return (table: unknown[] | TemplateStringsArray, ...values: unknown[]) => {
        let rows: unknown[][];
        if (Array.isArray(table) && 'raw' in (table as any)) {
            // Tagged template: a header row of names, then values.
            const header = (table as unknown as TemplateStringsArray).join('').split('|').map((s) => s.trim()).filter(Boolean);
            rows = [];
            for (let i = 0; i < values.length; i += header.length) rows.push([Object.fromEntries(header.map((h, j) => [h, values[i + j]]))]);
        } else rows = (table as unknown[]).map((r) => (Array.isArray(r) ? r : [r]));
        return (name: string, fn: (...args: any[]) => any, timeout?: number) =>
            rows.forEach((row, i) => register(format(name, row, i), () => fn(...row), timeout));
    };
}

function addTest(name: string, fn: TestFn | null, mode: Mode, timeout?: number) {
    currentSuite.children.push({ name, fn, mode: fn ? mode : 'todo', timeout: timeout ?? DEFAULT_TIMEOUT, suite: currentSuite });
}

function addSuite(name: string, fn: () => void, mode: Mode) {
    const suite = newSuite(name, currentSuite, mode);
    currentSuite.children.push(suite);
    const parent = currentSuite;
    currentSuite = suite;
    try {
        const r = fn() as unknown;
        if (r && typeof (r as Promise<void>).then === 'function') throw new Error(`describe("${name}") callback returned a promise: describe callbacks must be synchronous`);
    } finally {
        currentSuite = parent;
    }
}

type ItFn = ((name: string, fn?: TestFn, timeout?: number) => void) & {
    skip: (name: string, fn?: TestFn, timeout?: number) => void;
    only: (name: string, fn?: TestFn, timeout?: number) => void;
    todo: (name: string) => void;
    skipIf: (cond: unknown) => (name: string, fn?: TestFn, timeout?: number) => void;
    runIf: (cond: unknown) => (name: string, fn?: TestFn, timeout?: number) => void;
    each: ReturnType<typeof each>;
    concurrent: (name: string, fn?: TestFn, timeout?: number) => void;
};

export const it = ((name: string, fn?: TestFn, timeout?: number) => addTest(name, fn ?? null, 'run', timeout)) as ItFn;
it.skip = (name, fn, timeout) => addTest(name, fn ?? null, 'skip', timeout);
it.only = (name, fn, timeout) => addTest(name, fn ?? null, 'only', timeout);
it.todo = (name) => addTest(name, null, 'todo');
it.skipIf = (cond) => (cond ? it.skip : it);
it.runIf = (cond) => (cond ? it : it.skip);
it.each = each((name, fn, timeout) => addTest(name, fn, 'run', timeout));
it.concurrent = it;
export const test = it;

type DescribeFn = ((name: string, fn: () => void) => void) & {
    skip: (name: string, fn: () => void) => void;
    only: (name: string, fn: () => void) => void;
    todo: (name: string) => void;
    skipIf: (cond: unknown) => (name: string, fn: () => void) => void;
    runIf: (cond: unknown) => (name: string, fn: () => void) => void;
    each: ReturnType<typeof each>;
    concurrent: (name: string, fn: () => void) => void;
};

export const describe = ((name: string, fn: () => void) => addSuite(name, fn, 'run')) as DescribeFn;
describe.skip = (name, fn) => addSuite(name, fn, 'skip');
describe.only = (name, fn) => addSuite(name, fn, 'only');
describe.todo = (name) => addSuite(name, () => {}, 'todo');
describe.skipIf = (cond) => (cond ? describe.skip : describe);
describe.runIf = (cond) => (cond ? describe : describe.skip);
describe.each = each((name, fn) => addSuite(name, fn, 'run'));
describe.concurrent = describe;
export const suite = describe;

export const beforeAll = (fn: TestFn) => void currentSuite.beforeAll.push(fn);
export const afterAll = (fn: TestFn) => void currentSuite.afterAll.push(fn);
export const beforeEach = (fn: TestFn) => void currentSuite.beforeEach.push(fn);
export const afterEach = (fn: TestFn) => void currentSuite.afterEach.push(fn);

export { expect, vi };

/** The globals test files see (Vitest's `globals: true`, Jest's defaults). */
export const globals = { describe, suite, it, test, beforeAll, afterAll, beforeEach, afterEach, expect, vi, jest: vi };
