/**
 * One test file of `lunx test`, in a worker thread of its own (its modules,
 * globals and timers isolated from the other files').
 */

import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'node:module';
import path from 'node:path';
import util from 'node:util';
import { pathToFileURL } from 'node:url';

export interface WorkerInput {
    file: string;
    root: string;
    environment: 'node' | 'jsdom' | 'happy-dom';
    update: boolean;
    ci: boolean;
    coverage: boolean;
    testNamePattern?: string;
    setupFiles: string[];
}

export interface TestResult {
    name: string;
    status: 'pass' | 'fail' | 'skip' | 'todo';
    duration: number;
    error?: { message: string; stack?: string; expected?: string; actual?: string };
}

export interface FileResult {
    file: string;
    tests: TestResult[];
    error?: { message: string; stack?: string };
    snapshots: { added: number; updated: number; matched: number; failed: number };
    coverage: Array<[string, Array<[number, number]>]>;
    duration: number;
}

const input = workerData as WorkerInput;
// The runner's own timers: a test's vi.useFakeTimers() replaces the globals.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function serializeError(err: any): TestResult['error'] {
    const message = err instanceof Error ? `${err.name === 'Error' || err.name === 'AssertionError' ? '' : `${err.name}: `}${err.message}` : `thrown: ${util.inspect(err)}`;
    const stack = err instanceof Error && err.stack
        ? err.stack.split('\n').slice(1).filter((l) => !/[\\/](test[\\/](expect|api|worker|mock|snapshot)|node:internal)/.test(l)).slice(0, 6).join('\n')
        : undefined;
    const show = err?.showDiff;
    const fmt = (v: unknown) => (typeof v === 'string' ? v : util.inspect(v, { depth: 8, compact: false, sorted: true, breakLength: 80 }));
    return { message, stack, ...(show ? { expected: fmt(err.expected), actual: fmt(err.actual) } : {}) };
}

async function main(): Promise<FileResult> {
    const started = performance.now();
    // TypeScript test files: lunx's loader, and stack traces through its source maps.
    const mod = await import('node:module');
    if (typeof (mod as any).registerHooks === 'function') {
        const hooks = await import('./ts-hooks.js');
        (mod as any).registerHooks({ resolve: hooks.resolveSync, load: hooks.loadSync });
    } else register(new URL('./ts-hooks.js', import.meta.url));
    process.setSourceMapsEnabled(true);
    const coverage = input.coverage ? await import('./coverage.js') : null;
    await coverage?.startCoverage();

    const api = await import('./api.js');
    const { state } = await import('./expect.js');
    const { resetMockState } = await import('./mock.js');
    const snapshots = await import('./snapshot.js');
    const { setupEnvironment } = await import('./environment.js');

    Object.assign(globalThis, api.globals);
    const teardown = await setupEnvironment(input.environment, input.root);
    snapshots.startFile(input.file, { update: input.update, ci: input.ci });
    const tests: TestResult[] = [];
    let fileError: FileResult['error'];
    let allRan = true;
    try {
        for (const setup of input.setupFiles) await import(pathToFileURL(setup).href);
        await import(pathToFileURL(input.file).href);
        const root = api.takeRoot();
        const pattern = input.testNamePattern ? new RegExp(input.testNamePattern) : null;
        const hasOnly = (s: any): boolean => s.mode === 'only' || (s.children ?? []).some(hasOnly);
        const only = hasOnly(root);
        if (only || pattern) allRan = false;

        const run = async (fn: (done?: any) => any, timeout: number) => {
            let timer: NodeJS.Timeout | undefined;
            const call = fn.length > 0
                ? new Promise<void>((resolve, reject) => fn((err?: unknown) => (err ? reject(err) : resolve())))
                : Promise.resolve().then(() => fn());
            try {
                await Promise.race([
                    call,
                    new Promise((_, reject) => {
                        timer = realSetTimeout(() => reject(new Error(`timed out after ${timeout} ms`)), timeout);
                    }),
                ]);
            } finally {
                realClearTimeout(timer);
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
                        fileError ??= serializeError(err);
                    }
                }
            }
        };
        await visit(root, [], false, false, []);
    } catch (err) {
        fileError = serializeError(err);
        allRan = false;
    }
    const snapshotStats = snapshots.finishFile(allRan && !fileError);
    try {
        teardown();
    } catch {
        // environment teardown errors do not fail the file
    }
    resetMockState();
    const testFiles = new Set([path.resolve(input.file)]);
    const covered = coverage ? await coverage.takeCoverage(input.root, (f) => !testFiles.has(f) && !/\.(test|spec)\.[mc]?[jt]sx?$/.test(f)) : [];
    return { file: input.file, tests, error: fileError, snapshots: snapshotStats, coverage: covered, duration: performance.now() - started };
}

main().then(
    (result) => parentPort!.postMessage(result),
    (err) => parentPort!.postMessage({ file: input.file, tests: [], error: serializeError(err), snapshots: { added: 0, updated: 0, matched: 0, failed: 0 }, coverage: [], duration: 0 } satisfies FileResult),
);
