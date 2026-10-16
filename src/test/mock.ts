/**
 * `vi` for `lunx test`: mock functions, spies, fake timers, stubbed globals
 * and env vars, `vi.waitFor` — Vitest's API (and Jest's `jest.fn` shape).
 */

const MOCK = Symbol.for('lunx.mock');

type Impl = (...args: any[]) => any;

export interface MockResult {
    type: 'return' | 'throw' | 'incomplete';
    value: unknown;
}

export interface Mock<F extends Impl = Impl> {
    (...args: Parameters<F>): ReturnType<F>;
    mock: { calls: Parameters<F>[]; results: MockResult[]; instances: unknown[]; contexts: unknown[]; lastCall: Parameters<F> | undefined };
    mockImplementation(fn: F): Mock<F>;
    mockImplementationOnce(fn: F): Mock<F>;
    mockReturnValue(v: ReturnType<F>): Mock<F>;
    mockReturnValueOnce(v: ReturnType<F>): Mock<F>;
    mockResolvedValue(v: unknown): Mock<F>;
    mockResolvedValueOnce(v: unknown): Mock<F>;
    mockRejectedValue(v: unknown): Mock<F>;
    mockRejectedValueOnce(v: unknown): Mock<F>;
    mockReturnThis(): Mock<F>;
    mockName(name: string): Mock<F>;
    getMockName(): string;
    getMockImplementation(): F | undefined;
    mockClear(): Mock<F>;
    mockReset(): Mock<F>;
    mockRestore(): void;
}

const mocks = new Set<Mock>();

export const isMock = (fn: unknown): fn is Mock => typeof fn === 'function' && (fn as any)[MOCK] === true;

export function fn<F extends Impl = Impl>(impl?: F, restore?: () => void): Mock<F> {
    let base: F | undefined = impl;
    const once: F[] = [];
    let name = 'vi.fn()';
    const mock: any = function (this: unknown, ...args: any[]) {
        state.calls.push(args);
        state.contexts.push(this);
        state.lastCall = args;
        const result: MockResult = { type: 'incomplete', value: undefined };
        state.results.push(result);
        const run = once.shift() ?? base;
        try {
            const value = run ? (new.target ? Reflect.construct(run as any, args, new.target) : run.apply(this, args)) : undefined;
            if (new.target) state.instances.push(value ?? this);
            result.type = 'return';
            result.value = value;
            return value;
        } catch (error) {
            result.type = 'throw';
            result.value = error;
            throw error;
        }
    };
    const state = { calls: [] as any[], results: [] as MockResult[], instances: [] as unknown[], contexts: [] as unknown[], lastCall: undefined as any };
    mock[MOCK] = true;
    mock.mock = state;
    const self = mock as Mock<F>;
    self.mockImplementation = (f) => ((base = f), self);
    self.mockImplementationOnce = (f) => (once.push(f), self);
    self.mockReturnValue = (v) => self.mockImplementation((() => v) as F);
    self.mockReturnValueOnce = (v) => self.mockImplementationOnce((() => v) as F);
    self.mockResolvedValue = (v) => self.mockImplementation((() => Promise.resolve(v)) as F);
    self.mockResolvedValueOnce = (v) => self.mockImplementationOnce((() => Promise.resolve(v)) as F);
    self.mockRejectedValue = (v) => self.mockImplementation((() => Promise.reject(v)) as F);
    self.mockRejectedValueOnce = (v) => self.mockImplementationOnce((() => Promise.reject(v)) as F);
    self.mockReturnThis = () => self.mockImplementation(function (this: unknown) {
        return this;
    } as F);
    self.mockName = (n) => ((name = n), self);
    self.getMockName = () => name;
    self.getMockImplementation = () => base;
    self.mockClear = () => {
        state.calls.length = 0;
        state.results.length = 0;
        state.instances.length = 0;
        state.contexts.length = 0;
        state.lastCall = undefined;
        return self;
    };
    self.mockReset = () => {
        self.mockClear();
        base = impl;
        once.length = 0;
        return self;
    };
    self.mockRestore = () => {
        self.mockReset();
        restore?.();
    };
    mocks.add(self as Mock);
    return self;
}

export function spyOn(obj: any, method: string, access?: 'get' | 'set'): Mock {
    if (access) {
        const desc = Object.getOwnPropertyDescriptor(obj, method) ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(obj), method);
        if (!desc) throw new Error(`vi.spyOn: ${method} is not a property`);
        const original = desc[access]!;
        const spy = fn(original as Impl, () => Object.defineProperty(obj, method, desc));
        Object.defineProperty(obj, method, { ...desc, [access]: spy });
        return spy;
    }
    const original = obj[method];
    if (typeof original !== 'function') throw new Error(`vi.spyOn: ${String(method)} is not a function`);
    const own = Object.prototype.hasOwnProperty.call(obj, method);
    const spy = fn(original, () => {
        if (own) obj[method] = original;
        else delete obj[method];
    });
    obj[method] = spy;
    return spy;
}

// ── Fake timers ──────────────────────────────────────────────────────────────

interface Timer {
    id: number;
    at: number;
    fn: (...args: any[]) => void;
    args: unknown[];
    interval: number | null;
}

const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
    clearImmediate: globalThis.clearImmediate,
    Date: globalThis.Date,
    performanceNow: performance.now.bind(performance),
};

let clock: { now: number; timers: Map<number, Timer>; nextId: number } | null = null;

function fakeDate(): DateConstructor {
    const RealDate = real.Date;
    class FakeDate extends RealDate {
        constructor(...args: any[]) {
            if (args.length === 0) super(clock!.now);
            else super(...(args as [any]));
        }
        static now() {
            return clock!.now;
        }
    }
    return FakeDate as unknown as DateConstructor;
}

function useFakeTimers(opts: { now?: number | Date } = {}) {
    clock = { now: opts.now ? +opts.now : real.Date.now(), timers: new Map(), nextId: 1 };
    const add = (fnc: any, ms: any, args: unknown[], interval: boolean) => {
        const id = clock!.nextId++;
        const delay = Math.max(0, Number(ms) || 0);
        clock!.timers.set(id, { id, at: clock!.now + delay, fn: fnc, args, interval: interval ? Math.max(1, delay) : null });
        return id;
    };
    const g = globalThis as any;
    g.setTimeout = (f: any, ms?: number, ...args: unknown[]) => add(f, ms, args, false);
    g.setInterval = (f: any, ms?: number, ...args: unknown[]) => add(f, ms, args, true);
    g.setImmediate = (f: any, ...args: unknown[]) => add(f, 0, args, false);
    g.clearTimeout = g.clearInterval = g.clearImmediate = (id: number) => void clock?.timers.delete(Number(id));
    g.Date = fakeDate();
    performance.now = () => clock!.now;
}

function useRealTimers() {
    const g = globalThis as any;
    g.setTimeout = real.setTimeout;
    g.clearTimeout = real.clearTimeout;
    g.setInterval = real.setInterval;
    g.clearInterval = real.clearInterval;
    g.setImmediate = real.setImmediate;
    g.clearImmediate = real.clearImmediate;
    g.Date = real.Date;
    performance.now = real.performanceNow;
    clock = null;
}

function next(limit = Infinity): Timer | null {
    let best: Timer | null = null;
    for (const t of clock!.timers.values()) if (t.at <= limit && (!best || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
    return best;
}

function fire(t: Timer) {
    clock!.now = Math.max(clock!.now, t.at);
    if (t.interval) t.at += t.interval;
    else clock!.timers.delete(t.id);
    t.fn(...t.args);
}

const needClock = () => {
    if (!clock) throw new Error('fake timers are not on: call vi.useFakeTimers() first');
    return clock;
};

function advanceTimersByTime(ms: number) {
    const c = needClock();
    const end = c.now + ms;
    for (let t = next(end), n = 0; t && n < 100_000; t = next(end), n++) fire(t);
    c.now = end;
}

function runAllTimers() {
    needClock();
    for (let t = next(), n = 0; t; t = next(), n++) {
        if (n > 10_000) throw new Error('vi.runAllTimers: aborted after 10000 timers (an interval or a timer that schedules itself)');
        fire(t);
    }
}

function runOnlyPendingTimers() {
    const c = needClock();
    const pending = [...c.timers.values()].sort((a, b) => a.at - b.at || a.id - b.id);
    for (const t of pending) if (c.timers.has(t.id)) fire(t);
}

// ── Stubs ────────────────────────────────────────────────────────────────────

const stubbedGlobals = new Map<string, PropertyDescriptor | undefined>();
const stubbedEnv = new Map<string, string | undefined>();

export const vi = {
    fn,
    spyOn,
    isMockFunction: isMock,
    clearAllMocks: () => mocks.forEach((m) => m.mockClear()),
    resetAllMocks: () => mocks.forEach((m) => m.mockReset()),
    restoreAllMocks: () => mocks.forEach((m) => m.mockRestore()),
    useFakeTimers: (opts?: { now?: number | Date }) => (useFakeTimers(opts), vi),
    useRealTimers: () => (useRealTimers(), vi),
    isFakeTimers: () => clock !== null,
    advanceTimersByTime: (ms: number) => (advanceTimersByTime(ms), vi),
    advanceTimersByTimeAsync: async (ms: number) => {
        advanceTimersByTime(ms);
        await new Promise((r) => real.setImmediate(r));
        return vi;
    },
    advanceTimersToNextTimer: () => {
        const t = next();
        if (t) fire(t);
        return vi;
    },
    runAllTimers: () => (runAllTimers(), vi),
    runAllTimersAsync: async () => {
        runAllTimers();
        await new Promise((r) => real.setImmediate(r));
        return vi;
    },
    runOnlyPendingTimers: () => (runOnlyPendingTimers(), vi),
    getTimerCount: () => clock?.timers.size ?? 0,
    clearAllTimers: () => void clock?.timers.clear(),
    setSystemTime: (time: number | Date) => {
        if (clock) clock.now = +time;
        else throw new Error('vi.setSystemTime needs vi.useFakeTimers()');
        return vi;
    },
    getRealSystemTime: () => real.Date.now(),
    stubGlobal: (name: string, value: unknown) => {
        if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
        return vi;
    },
    unstubAllGlobals: () => {
        for (const [name, desc] of stubbedGlobals) {
            if (desc) Object.defineProperty(globalThis, name, desc);
            else delete (globalThis as any)[name];
        }
        stubbedGlobals.clear();
        return vi;
    },
    stubEnv: (name: string, value: string | undefined) => {
        if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
        return vi;
    },
    unstubAllEnvs: () => {
        for (const [name, value] of stubbedEnv) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        stubbedEnv.clear();
        return vi;
    },
    /** Retries `callback` until it stops throwing (or its promise resolves), as Vitest's. */
    waitFor: async <T>(callback: () => T | Promise<T>, options: number | { timeout?: number; interval?: number } = {}): Promise<T> => {
        const { timeout = 1000, interval = 50 } = typeof options === 'number' ? { timeout: options } : options;
        const deadline = real.Date.now() + timeout;
        for (;;) {
            try {
                return await callback();
            } catch (error) {
                if (real.Date.now() > deadline) throw error;
                await new Promise((r) => real.setTimeout(r, interval));
            }
        }
    },
    /** `vi.hoisted(() => …)`: runs the factory (lunx does not hoist; the value is returned as is). */
    hoisted: <T>(factory: () => T): T => factory(),
};

/** After each test file: real timers, globals and env vars back. */
export function resetMockState() {
    if (clock) useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    mocks.clear();
}
