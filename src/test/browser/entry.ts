/**
 * Browser mode of `lunx test`: runs one test file in the page (Chromium,
 * Firefox or WebKit through Playwright) with the same API and test walk as
 * the worker, and hands the results to the runner.
 */

import util from 'node:util';
import * as api from '../api.js';
import { state } from '../expect.js';
import { resetMockState } from '../mock.js';
import * as snapshots from '../snapshot.js';
import { runSuite } from '../run-suite.js';
import { writes } from './fs.js';

interface Input {
    file: string;
    update: boolean;
    ci: boolean;
    testNamePattern?: string;
}

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

function serializeError(err: any) {
    const message = err instanceof Error ? `${err.name === 'Error' || err.name === 'AssertionError' ? '' : `${err.name}: `}${err.message}` : `thrown: ${util.inspect(err)}`;
    const stack = err instanceof Error && err.stack ? err.stack.split('\n').slice(1).filter((l: string) => !/\/@lunx\/test-runtime\//.test(l)).slice(0, 6).join('\n') : undefined;
    const fmt = (v: unknown) => (typeof v === 'string' ? v : util.inspect(v, { depth: 8, compact: false, sorted: true, breakLength: 80 }));
    return { message, stack, ...(err?.showDiff ? { expected: fmt(err.expected), actual: fmt(err.actual) } : {}) };
}

export async function runInBrowser(input: Input, setups: Array<() => Promise<unknown>>, load: () => Promise<unknown>): Promise<void> {
    const started = performance.now();
    Object.assign(globalThis, api.globals);
    snapshots.startFile(input.file, { update: input.update, ci: input.ci });
    let tests: any[] = [];
    let fileError: any;
    let allRan = true;
    try {
        for (const setup of setups) await setup();
        await load();
        const out = await runSuite({ root: api.takeRoot(), file: input.file, testNamePattern: input.testNamePattern, state, setTimeout: realSetTimeout, clearTimeout: realClearTimeout, serializeError });
        tests = out.tests;
        fileError = out.fileError;
        allRan = out.allRan;
    } catch (err) {
        fileError = serializeError(err);
        allRan = false;
    }
    const snapshotStats = snapshots.finishFile(allRan && !fileError);
    resetMockState();
    await (globalThis as any).__lunx_done({ file: input.file, tests, error: fileError, snapshots: snapshotStats, coverage: [], duration: performance.now() - started, writes });
}
