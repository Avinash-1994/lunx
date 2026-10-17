/**
 * The test walk of `lunx test`, shared by the worker (./worker.ts, Node) and
 * browser mode (./browser-entry.ts, in the page): hooks, only / skip / todo,
 * timeouts and assertion counts, per test of a collected file.
 */

import type { TestResult } from './worker.js';

export interface RunSuiteInput {
    root: any;
    file: string;
    testNamePattern?: string;
    state: any;
    /** The real timers (a test's fake timers replace the globals). */
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
    serializeError(err: unknown): TestResult['error'];
}

export async function runSuite(input: RunSuiteInput): Promise<{ tests: TestResult[]; fileError?: { message: string; stack?: string }; allRan: boolean }> {
    const { root, state, serializeError } = input;
    const tests: TestResult[] = [];
    let fileError: { message: string; stack?: string } | undefined;
    const pattern = input.testNamePattern ? new RegExp(input.testNamePattern) : null;
    const hasOnly = (s: any): boolean => s.mode === 'only' || (s.children ?? []).some(hasOnly);
    const only = hasOnly(root);
    const allRan = !(only || pattern);

    const run = async (fn: (done?: any) => any, timeout: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const call = fn.length > 0
            ? new Promise<void>((resolve, reject) => fn((err?: unknown) => (err ? reject(err) : resolve())))
            : Promise.resolve().then(() => fn());
        try {
            await Promise.race([
                call,
                new Promise((_, reject) => {
                    timer = input.setTimeout(() => reject(new Error(`timed out after ${timeout} ms`)), timeout);
                }),
            ]);
        } finally {
            input.clearTimeout(timer);
        }
    };

    const visit = async (suite: any, names: string[], skip: boolean, selected: boolean, eachHooks: any[]) => {
        const suiteSkip = skip || suite.mode === 'skip' || suite.mode === 'todo';
        const suiteSelected = selected || suite.mode === 'only';
        const hooks = [...eachHooks, suite];
        const live = (c: any): boolean => (c.children ? c.children.some(live) : !suiteSkip && c.mode !== 'skip' && c.mode !== 'todo');
        let beforeAllError: unknown = null;
        if (suite.children.some(live)) {
            for (const h of suite.beforeAll) {
                try {
                    await run(h, 10_000);
                } catch (err) {
                    beforeAllError = err;
                    break;
                }
            }
        }
        for (const child of suite.children) {
            if (child.children) {
                await visit(child, child.name ? [...names, child.name] : names, suiteSkip, suiteSelected, hooks);
                continue;
            }
            const name = [...names, child.name].join(' > ');
            const chosen = (!only || suiteSelected || child.mode === 'only') && (!pattern || pattern.test(name));
            if (child.mode === 'todo') {
                tests.push({ name, status: 'todo', duration: 0 });
                continue;
            }
            if (suiteSkip || child.mode === 'skip' || !chosen) {
                tests.push({ name, status: 'skip', duration: 0 });
                continue;
            }
            const t0 = performance.now();
            state.assertions = 0;
            state.expected = null;
            state.hasAssertions = false;
            state.testName = name;
            state.testFile = input.file;
            let error: unknown = beforeAllError;
            if (!error) {
                try {
                    for (const s of hooks) for (const h of s.beforeEach) await run(h, child.timeout);
                    await run(child.fn, child.timeout);
                    if (state.expected !== null && state.assertions !== state.expected) throw new Error(`expected ${state.expected} assertion${state.expected === 1 ? '' : 's'}, ${state.assertions} ran`);
                    if (state.hasAssertions && state.assertions === 0) throw new Error('expected at least one assertion');
                } catch (err) {
                    error = err;
                }
                for (const s of [...hooks].reverse()) {
                    for (const h of s.afterEach) {
                        try {
                            await run(h, child.timeout);
                        } catch (err) {
                            error ??= err;
                        }
                    }
                }
            }
            tests.push({ name, status: error ? 'fail' : 'pass', duration: performance.now() - t0, ...(error ? { error: serializeError(error) } : {}) });
        }
        if (suite.children.some(live)) {
            for (const h of suite.afterAll) {
                try {
                    await run(h, 10_000);
                } catch (err) {
                    fileError ??= serializeError(err) as any;
                }
            }
        }
    };
    await visit(root, [], false, false, []);
    return { tests, fileError, allRan };
}
