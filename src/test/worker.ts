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
    let tests: TestResult[] = [];
    let fileError: FileResult['error'];
    let allRan = true;
    try {
        for (const setup of input.setupFiles) await import(pathToFileURL(setup).href);
        await import(pathToFileURL(input.file).href);
        const { runSuite } = await import('./run-suite.js');
        const out = await runSuite({
            root: api.takeRoot(),
            file: input.file,
            testNamePattern: input.testNamePattern,
            state,
            setTimeout: realSetTimeout,
            clearTimeout: realClearTimeout,
            serializeError,
        });
        tests = out.tests;
        fileError = out.fileError;
        allRan = out.allRan;
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
