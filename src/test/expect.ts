/**
 * `expect` for `lunx test`: Jest's and Vitest's matchers and equality.
 *
 * `toEqual` compares recursively, ignoring properties whose value is
 * undefined; `toStrictEqual` also compares those, array holes and classes.
 * Asymmetric matchers (`expect.any(Number)`, `expect.objectContaining({…})`…)
 * work anywhere inside an expected value.
 */

import util from 'node:util';
import { isMock } from './mock.js';
import { matchSnapshot, matchInlineSnapshot } from './snapshot.js';

export class AssertionError extends Error {
    constructor(message: string, public expected?: unknown, public actual?: unknown, public showDiff = false) {
        super(message);
        this.name = 'AssertionError';
    }
}

// ── Asymmetric matchers ──────────────────────────────────────────────────────

export abstract class Asymmetric {
    constructor(public inverse = false) {}
    abstract matches(other: unknown): boolean;
    abstract toString(): string;
    [util.inspect.custom]() {
        return this.toString();
    }
}

class Any extends Asymmetric {
    constructor(private type: any) {
        super();
    }
    matches(v: unknown) {
        const t = this.type;
        if (t === String) return typeof v === 'string' || v instanceof String;
        if (t === Number) return typeof v === 'number' || v instanceof Number;
        if (t === Boolean) return typeof v === 'boolean' || v instanceof Boolean;
        if (t === BigInt) return typeof v === 'bigint';
        if (t === Symbol) return typeof v === 'symbol';
        if (t === Function) return typeof v === 'function';
        if (t === Object) return typeof v === 'object' && v !== null;
        return v instanceof t;
    }
    toString() {
        return `Any<${this.type?.name ?? this.type}>`;
    }
}
class Anything extends Asymmetric {
    matches(v: unknown) {
        return v !== null && v !== undefined;
    }
    toString() {
        return 'Anything';
    }
}
class StringContaining extends Asymmetric {
    constructor(private sub: string, inverse = false) {
        super(inverse);
    }
    matches(v: unknown) {
        const r = typeof v === 'string' && v.includes(this.sub);
        return this.inverse ? !r : r;
    }
    toString() {
        return `String${this.inverse ? 'Not' : ''}Containing ${JSON.stringify(this.sub)}`;
    }
}
class StringMatching extends Asymmetric {
    constructor(private re: RegExp, inverse = false) {
        super(inverse);
    }
    matches(v: unknown) {
        const r = typeof v === 'string' && this.re.test(v);
        return this.inverse ? !r : r;
    }
    toString() {
        return `String${this.inverse ? 'Not' : ''}Matching ${this.re}`;
    }
}
class ObjectContaining extends Asymmetric {
    constructor(private sample: Record<string, unknown>, inverse = false) {
        super(inverse);
    }
    matches(v: unknown) {
        const r = typeof v === 'object' && v !== null && Object.keys(this.sample).every((k) => k in (v as any) && equals((v as any)[k], this.sample[k]));
        return this.inverse ? !r : r;
    }
    toString() {
        return `Object${this.inverse ? 'Not' : ''}Containing ${util.inspect(this.sample)}`;
    }
}
class ArrayContaining extends Asymmetric {
    constructor(private sample: unknown[], inverse = false) {
        super(inverse);
    }
    matches(v: unknown) {
        const r = Array.isArray(v) && this.sample.every((s) => v.some((x) => equals(x, s)));
        return this.inverse ? !r : r;
    }
    toString() {
        return `Array${this.inverse ? 'Not' : ''}Containing ${util.inspect(this.sample)}`;
    }
}
class CloseTo extends Asymmetric {
    constructor(private n: number, private digits = 2, inverse = false) {
        super(inverse);
    }
    matches(v: unknown) {
        const r = typeof v === 'number' && Math.abs(v - this.n) < 10 ** -this.digits / 2;
        return this.inverse ? !r : r;
    }
    toString() {
        return `NumberCloseTo ${this.n} (${this.digits} digits)`;
    }
}

// ── Equality ─────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<PropertyKey, unknown> => typeof v === 'object' && v !== null;

export function equals(a: unknown, b: unknown, strict = false, seen = new Map<unknown, unknown>()): boolean {
    if (b instanceof Asymmetric) return b.matches(a);
    if (a instanceof Asymmetric) return a.matches(b);
    if (Object.is(a, b)) return true;
    if (!isObject(a) || !isObject(b)) return false;
    if (seen.get(a) === b) return true;
    seen.set(a, b);
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
    if (a instanceof Error && b instanceof Error) return a.name === b.name && a.message === b.message;
    if (a instanceof Map || b instanceof Map) {
        if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
        for (const [k, v] of a) if (!b.has(k) || !equals(v, b.get(k), strict, seen)) return false;
        return true;
    }
    if (a instanceof Set || b instanceof Set) {
        if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
        for (const v of a) if (!b.has(v) && ![...b].some((w) => equals(v, w, strict, seen))) return false;
        return true;
    }
    if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
        if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false;
        const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        return x.every((v, i) => v === y[i]);
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (strict && (i in a) !== (i in b)) return false;
            if (!equals(a[i], b[i], strict, seen)) return false;
        }
        if (!strict) return true;
    }
    const keys = (o: Record<PropertyKey, unknown>) =>
        [...Object.keys(o), ...Object.getOwnPropertySymbols(o).filter((s) => Object.prototype.propertyIsEnumerable.call(o, s))].filter((k) => strict || o[k as any] !== undefined);
    const ka = keys(a as any);
    const kb = keys(b as any);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (strict && !Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!equals((a as any)[k], (b as any)[k], strict, seen)) return false;
    }
    return true;
}

/** `actual` has every property of `expected` (recursively, arrays element by element). */
function matchesObject(actual: unknown, expected: unknown): boolean {
    if (expected instanceof Asymmetric) return expected.matches(actual);
    if (!isObject(expected) || !isObject(actual)) return equals(actual, expected);
    if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesObject(actual[i], e));
    if (expected instanceof Date || expected instanceof RegExp || expected instanceof Map || expected instanceof Set) return equals(actual, expected);
    return Object.keys(expected).every((k) => k in actual && matchesObject((actual as any)[k], (expected as any)[k]));
}

export const format = (v: unknown) => util.inspect(v, { depth: 8, colors: false, compact: 3, breakLength: 100, sorted: false });

// ── Matchers ─────────────────────────────────────────────────────────────────

interface State {
    assertions: number;
    expected: number | null;
    hasAssertions: boolean;
    /** The running test's full name, for snapshots. */
    testName: string;
    testFile: string;
}

export const state: State = { assertions: 0, expected: null, hasAssertions: false, testName: '', testFile: '' };

function pathGet(obj: any, keyPath: string | (string | number)[]): { found: boolean; value: unknown } {
    const parts = Array.isArray(keyPath) ? keyPath : keyPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const p of parts) {
        if (cur === null || cur === undefined || !(Object(cur) instanceof Object) || !(p in Object(cur))) return { found: false, value: undefined };
        cur = cur[p as any];
    }
    return { found: true, value: cur };
}

function thrown(fn: unknown): { threw: boolean; error: any } {
    if (typeof fn !== 'function') throw new AssertionError('expect(…).toThrow() needs a function');
    try {
        fn();
        return { threw: false, error: undefined };
    } catch (error) {
        return { threw: true, error };
    }
}

function throwMatches(error: any, expected: unknown): boolean {
    if (expected === undefined) return true;
    const message = error instanceof Error ? error.message : String(error);
    if (typeof expected === 'string') return message.includes(expected);
    if (expected instanceof RegExp) return expected.test(message);
    if (typeof expected === 'function') return error instanceof (expected as any);
    if (expected instanceof Asymmetric) return expected.matches(error);
    if (isObject(expected)) return message === (expected as any).message;
    return false;
}

type MatcherResult = { pass: boolean; message: () => string; expected?: unknown; actual?: unknown; diff?: boolean };

const custom: Record<string, (this: { isNot: boolean; equals: typeof equals }, actual: unknown, ...args: any[]) => MatcherResult> = {};

function calls(fn: any, name: string) {
    if (!isMock(fn)) throw new AssertionError(`${name} needs a mock or spy (vi.fn(), vi.spyOn()), received ${format(fn)}`);
    return fn.mock.calls as unknown[][];
}

const matchers: Record<string, (actual: any, ...args: any[]) => MatcherResult> = {
    toBe: (a, e) => ({ pass: Object.is(a, e), message: () => `expected ${format(a)} to be ${format(e)}${!Object.is(a, e) && equals(a, e, true) ? ' (equal value, different object: use toEqual)' : ''}`, expected: e, actual: a, diff: true }),
    toEqual: (a, e) => ({ pass: equals(a, e), message: () => `expected ${format(a)} to equal ${format(e)}`, expected: e, actual: a, diff: true }),
    toStrictEqual: (a, e) => ({ pass: equals(a, e, true), message: () => `expected ${format(a)} to strictly equal ${format(e)}`, expected: e, actual: a, diff: true }),
    toMatchObject: (a, e) => ({ pass: matchesObject(a, e), message: () => `expected ${format(a)} to match object ${format(e)}`, expected: e, actual: a, diff: true }),
    toBeTruthy: (a) => ({ pass: !!a, message: () => `expected ${format(a)} to be truthy` }),
    toBeFalsy: (a) => ({ pass: !a, message: () => `expected ${format(a)} to be falsy` }),
    toBeNull: (a) => ({ pass: a === null, message: () => `expected ${format(a)} to be null` }),
    toBeUndefined: (a) => ({ pass: a === undefined, message: () => `expected ${format(a)} to be undefined` }),
    toBeDefined: (a) => ({ pass: a !== undefined, message: () => `expected ${format(a)} to be defined` }),
    toBeNaN: (a) => ({ pass: Number.isNaN(a), message: () => `expected ${format(a)} to be NaN` }),
    toBeTypeOf: (a, t) => ({ pass: typeof a === t, message: () => `expected ${format(a)} to be of type ${t}` }),
    toBeInstanceOf: (a, c) => ({ pass: a instanceof c, message: () => `expected ${format(a)} to be an instance of ${c?.name ?? c}` }),
    toBeGreaterThan: (a, n) => ({ pass: a > n, message: () => `expected ${format(a)} to be greater than ${n}` }),
    toBeGreaterThanOrEqual: (a, n) => ({ pass: a >= n, message: () => `expected ${format(a)} to be greater than or equal to ${n}` }),
    toBeLessThan: (a, n) => ({ pass: a < n, message: () => `expected ${format(a)} to be less than ${n}` }),
    toBeLessThanOrEqual: (a, n) => ({ pass: a <= n, message: () => `expected ${format(a)} to be less than or equal to ${n}` }),
    toBeCloseTo: (a, n, digits = 2) => ({ pass: Math.abs(a - n) < 10 ** -digits / 2, message: () => `expected ${format(a)} to be close to ${n} (${digits} digits)` }),
    toBeOneOf: (a, list: unknown[]) => ({ pass: list.some((x) => equals(a, x)), message: () => `expected ${format(a)} to be one of ${format(list)}` }),
    toSatisfy: (a, fn: (v: unknown) => boolean) => ({ pass: !!fn(a), message: () => `expected ${format(a)} to satisfy ${fn.name || 'the predicate'}` }),
    toContain: (a, item) => ({
        pass: typeof a === 'string' ? a.includes(item) : a != null && typeof a[Symbol.iterator] === 'function' ? [...a].includes(item) : false,
        message: () => `expected ${format(a)} to contain ${format(item)}`,
    }),
    toContainEqual: (a, item) => ({ pass: a != null && [...a].some((x: unknown) => equals(x, item)), message: () => `expected ${format(a)} to contain an item equal to ${format(item)}` }),
    toHaveLength: (a, n) => ({ pass: a != null && a.length === n, message: () => `expected ${format(a)} to have length ${n} (has ${a?.length})` }),
    toHaveProperty: (a, keyPath, ...value) => {
        const got = pathGet(a, keyPath);
        const pass = got.found && (value.length === 0 || equals(got.value, value[0]));
        return { pass, message: () => `expected ${format(a)} to have property ${format(keyPath)}${value.length ? ` equal to ${format(value[0])} (got ${format(got.value)})` : ''}` };
    },
    toMatch: (a, e) => ({ pass: typeof a === 'string' && (typeof e === 'string' ? a.includes(e) : e.test(a)), message: () => `expected ${format(a)} to match ${e}` }),
    toThrow: (fn, e) => {
        const r = thrown(fn);
        return { pass: r.threw && throwMatches(r.error, e), message: () => (r.threw ? `expected the thrown ${format(r.error)} to match ${format(e)}` : `expected the function to throw${e === undefined ? '' : ` ${format(e)}`}`) };
    },
    toHaveBeenCalled: (fn) => ({ pass: calls(fn, 'toHaveBeenCalled').length > 0, message: () => `expected ${fn.getMockName?.() ?? 'the mock'} to have been called` }),
    toHaveBeenCalledTimes: (fn, n) => ({ pass: calls(fn, 'toHaveBeenCalledTimes').length === n, message: () => `expected ${n} call${n === 1 ? '' : 's'}, got ${fn.mock.calls.length}` }),
    toHaveBeenCalledWith: (fn, ...args) => ({ pass: calls(fn, 'toHaveBeenCalledWith').some((c) => equals(c, args)), message: () => `expected a call with ${format(args)}; calls: ${format(fn.mock.calls)}` }),
    toHaveBeenLastCalledWith: (fn, ...args) => ({ pass: equals(calls(fn, 'toHaveBeenLastCalledWith').at(-1), args), message: () => `expected the last call to be ${format(args)}; it was ${format(fn.mock.calls.at(-1))}` }),
    toHaveBeenNthCalledWith: (fn, n, ...args) => ({ pass: equals(calls(fn, 'toHaveBeenNthCalledWith')[n - 1], args), message: () => `expected call ${n} to be ${format(args)}; it was ${format(fn.mock.calls[n - 1])}` }),
    toHaveReturned: (fn) => ({ pass: (calls(fn, 'toHaveReturned'), fn.mock.results.some((r: any) => r.type === 'return')), message: () => 'expected the mock to have returned' }),
    toHaveReturnedWith: (fn, v) => ({ pass: (calls(fn, 'toHaveReturnedWith'), fn.mock.results.some((r: any) => r.type === 'return' && equals(r.value, v))), message: () => `expected the mock to have returned ${format(v)}` }),
};
const aliases: Record<string, string> = {
    toThrowError: 'toThrow', toBeCalled: 'toHaveBeenCalled', toBeCalledTimes: 'toHaveBeenCalledTimes', toBeCalledWith: 'toHaveBeenCalledWith',
    lastCalledWith: 'toHaveBeenLastCalledWith', toHaveBeenLastCalledWith: 'toHaveBeenLastCalledWith', nthCalledWith: 'toHaveBeenNthCalledWith', toReturn: 'toHaveReturned', toReturnWith: 'toHaveReturnedWith',
};

function report(name: string, result: MatcherResult, isNot: boolean) {
    state.assertions++;
    if (result.pass === isNot) {
        const msg = result.message();
        throw new AssertionError(isNot ? msg.replace(/^expected (.*?) to /, 'expected $1 not to ') : msg, result.expected, result.actual, !isNot && !!result.diff);
    }
}

type Chain = Record<string, (...args: any[]) => any> & { not: Chain; resolves: Chain; rejects: Chain };

function chain(actual: unknown, isNot: boolean, mode: 'sync' | 'resolves' | 'rejects'): Chain {
    const target: any = {};
    const all = { ...matchers, ...Object.fromEntries(Object.entries(custom).map(([k, fn]) => [k, (a: unknown, ...args: any[]) => fn.call({ isNot, equals }, a, ...args)])) };
    for (const name of [...Object.keys(all), ...Object.keys(aliases), 'toMatchSnapshot', 'toMatchInlineSnapshot']) {
        const real = aliases[name] ?? name;
        target[name] = (...args: any[]) => {
            const runOn = (value: unknown) => {
                if (real === 'toMatchSnapshot') return report(name, matchSnapshot(value, args[0], state), isNot);
                if (real === 'toMatchInlineSnapshot') return report(name, matchInlineSnapshot(value, args[0], state), isNot);
                return report(name, (all as any)[real](value, ...args), isNot);
            };
            if (mode === 'sync') return runOn(actual);
            return Promise.resolve(actual).then(
                (value) => {
                    if (mode === 'rejects') throw new AssertionError(`expected the promise to reject, it resolved to ${format(value)}`);
                    return runOn(value);
                },
                (error) => {
                    if (mode === 'resolves') throw new AssertionError(`expected the promise to resolve, it rejected with ${format(error)}`);
                    // `.rejects.toThrow(…)` checks the rejection reason itself.
                    if (real === 'toThrow') return report(name, { pass: throwMatches(error, args[0]), message: () => `expected the rejection ${format(error)} to match ${format(args[0])}` }, isNot);
                    return runOn(error);
                },
            );
        };
    }
    Object.defineProperty(target, 'not', { get: () => chain(actual, !isNot, mode) });
    Object.defineProperty(target, 'resolves', { get: () => chain(actual, isNot, 'resolves') });
    Object.defineProperty(target, 'rejects', { get: () => chain(actual, isNot, 'rejects') });
    return target;
}

export interface ExpectStatic {
    <T>(actual: T): Chain;
    any(type: unknown): Asymmetric;
    anything(): Asymmetric;
    stringContaining(s: string): Asymmetric;
    stringMatching(re: RegExp | string): Asymmetric;
    objectContaining(o: Record<string, unknown>): Asymmetric;
    arrayContaining(a: unknown[]): Asymmetric;
    closeTo(n: number, digits?: number): Asymmetric;
    not: { stringContaining(s: string): Asymmetric; stringMatching(re: RegExp | string): Asymmetric; objectContaining(o: Record<string, unknown>): Asymmetric; arrayContaining(a: unknown[]): Asymmetric };
    assertions(n: number): void;
    hasAssertions(): void;
    extend(defs: Record<string, (this: { isNot: boolean; equals: typeof equals }, actual: unknown, ...args: any[]) => { pass: boolean; message: () => string }>): void;
    soft<T>(actual: T): Chain;
}

export const expect = ((actual: unknown) => chain(actual, false, 'sync')) as ExpectStatic;
expect.soft = (actual) => chain(actual, false, 'sync');
expect.any = (t) => new Any(t);
expect.anything = () => new Anything();
expect.stringContaining = (s) => new StringContaining(s);
expect.stringMatching = (re) => new StringMatching(typeof re === 'string' ? new RegExp(re) : re);
expect.objectContaining = (o) => new ObjectContaining(o);
expect.arrayContaining = (a) => new ArrayContaining(a);
expect.closeTo = (n, d) => new CloseTo(n, d);
expect.not = {
    stringContaining: (s) => new StringContaining(s, true),
    stringMatching: (re) => new StringMatching(typeof re === 'string' ? new RegExp(re) : re, true),
    objectContaining: (o) => new ObjectContaining(o, true),
    arrayContaining: (a) => new ArrayContaining(a, true),
};
expect.assertions = (n) => {
    state.expected = n;
};
expect.hasAssertions = () => {
    state.hasAssertions = true;
};
expect.extend = (defs) => Object.assign(custom, defs);
