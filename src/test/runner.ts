/**
 * `lunx test`: runs a project's tests, each file in a worker thread.
 *
 *   lunx test                      every *.test / *.spec file
 *   lunx test src/math             files whose path contains "src/math"
 *   lunx test -t "adds"            tests whose full name matches
 *   lunx test --environment jsdom  DOM globals (jsdom or happy-dom from the project)
 *   lunx test --coverage           V8 line coverage: table, coverage/lcov.info
 *   lunx test -u                   update snapshots
 *   lunx test --watch              re-run on changes
 *   lunx test --browser[=firefox]  in a real browser, through the project's Playwright (--headed to watch)
 *
 * A project with Vitest installed runs Vitest instead (on lunx's engine,
 * through `lunx exec vitest`); `--builtin` keeps lunx's runner.
 *
 * Options may also come from `test` in lunx.config: `environment`,
 * `include`, `exclude`, `setupFiles`, `coverage: true`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FileResult, WorkerInput } from './worker.js';

const DEFAULT_INCLUDE = /\.(test|spec)\.[mc]?[jt]sx?$|_test\.[mc]?[jt]s$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.lunx', 'coverage', '.next', '.nuxt', '.svelte-kit', '.output']);

const color = (code: number) => (s: string) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32);
const red = color(31);
const yellow = color(33);
const dim = color(2);
const bold = color(1);

interface Options {
    filters: string[];
    watch: boolean;
    update: boolean;
    ci: boolean;
    coverage: boolean;
    environment: WorkerInput['environment'];
    testNamePattern?: string;
    builtin: boolean;
    passWithNoTests: boolean;
    bail: boolean;
    browser?: 'chromium' | 'firefox' | 'webkit';
    headed: boolean;
}

function parseArgs(args: string[]): Options {
    const opts: Options = {
        filters: [],
        watch: false,
        update: false,
        ci: !!process.env.CI,
        coverage: false,
        environment: 'node',
        builtin: false,
        passWithNoTests: false,
        bail: false,
        headed: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        const value = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i]);
        if (a === '--watch' || a === '-w') opts.watch = true;
        else if (a === '--run') opts.watch = false;
        else if (a === '-u' || a === '--update') opts.update = true;
        else if (a === '--ci') opts.ci = true;
        else if (a === '--coverage') opts.coverage = true;
        else if (a === '--builtin') opts.builtin = true;
        else if (a === '--passWithNoTests' || a === '--pass-with-no-tests') opts.passWithNoTests = true;
        else if (a === '--bail') opts.bail = true;
        else if (a === '--browser') opts.browser = 'chromium';
        else if (a.startsWith('--browser=')) opts.browser = a.slice(10) as Options['browser'];
        else if (a === '--headed') opts.headed = true;
        else if (a.startsWith('--environment')) opts.environment = value() as Options['environment'];
        else if (a === '-t' || a.startsWith('--testNamePattern') || a.startsWith('--test-name-pattern')) opts.testNamePattern = value();
        else if (!a.startsWith('-')) opts.filters.push(a);
    }
    return opts;
}

function findTests(root: string, include: (rel: string) => boolean, exclude: (rel: string) => boolean): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (e.isDirectory()) {
                if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full);
            } else if (include(rel) && !exclude(rel)) out.push(full);
        }
    }
    return out.sort();
}

const globRe = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/\\\{([^}]*)\\\}/g, (_, alts: string) => `(?:${alts.split(',').join('|')})`)}$`);

async function testConfig(root: string): Promise<any> {
    try {
        const { loadConfig } = await import('../config/index.js');
        return ((await loadConfig(root)) as any).test ?? {};
    } catch {
        return {};
    }
}

function runFile(input: WorkerInput): Promise<FileResult> {
    return new Promise((resolve) => {
        const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: input, stdout: false, stderr: false });
        let result: FileResult | null = null;
        worker.once('message', (r: FileResult) => (result = r));
        const fail = (message: string): FileResult => ({ file: input.file, tests: [], error: { message }, snapshots: { added: 0, updated: 0, matched: 0, failed: 0 }, coverage: [], duration: 0 });
        worker.once('error', (err) => resolve(result ?? fail(err.stack ?? err.message)));
        worker.once('exit', (code) => resolve(result ?? fail(`worker exited with code ${code}`)));
    });
}

function printFile(root: string, r: FileResult) {
    const rel = path.relative(root, r.file).split(path.sep).join('/');
    const failed = r.tests.filter((t) => t.status === 'fail');
    const skipped = r.tests.filter((t) => t.status === 'skip' || t.status === 'todo').length;
    const ok = !failed.length && !r.error;
    const counts = `${r.tests.length} test${r.tests.length === 1 ? '' : 's'}${failed.length ? ` | ${failed.length} failed` : ''}${skipped ? ` | ${skipped} skipped` : ''}`;
    console.log(` ${ok ? green('✓') : red('✗')} ${rel} ${dim(`(${counts}) ${Math.round(r.duration)}ms`)}`);
    if (r.error) console.log(`\n   ${red(bold('Error'))} ${r.error.message}\n${dim(indent(r.error.stack ?? '', 5))}\n`);
    for (const t of failed) {
        console.log(`\n   ${red(bold('FAIL'))} ${t.name}`);
        console.log(indent(red(t.error!.message), 5));
        if (t.error!.expected !== undefined) {
            console.log(`\n     ${green('- Expected')}  ${red('+ Received')}\n`);
            for (const [mark, line] of lineDiff(t.error!.expected!, t.error!.actual ?? '')) {
                console.log(mark === '-' ? green(`     - ${line}`) : mark === '+' ? red(`     + ${line}`) : dim(`       ${line}`));
            }
            console.log('');
        }
        if (t.error!.stack) console.log(dim(indent(t.error!.stack.trim(), 5)));
    }
    if (failed.length) console.log('');
}

/** Line diff (longest common subsequence) of two formatted values. */
function lineDiff(expected: string, actual: string): Array<['-' | '+' | ' ', string]> {
    const a = expected.split('\n');
    const b = actual.split('\n');
    if (a.length * b.length > 250_000) return [...a.map((l) => ['-', l] as ['-', string]), ...b.map((l) => ['+', l] as ['+', string])];
    const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    const out: Array<['-' | '+' | ' ', string]> = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            out.push([' ', a[i]!]);
            i++;
            j++;
        }
        else if (i < a.length && (j === b.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) out.push(['-', a[i++]!]);
        else out.push(['+', b[j++]!]);
    }
    return out;
}

const indent = (text: string, n: number) => text.split('\n').map((l) => ' '.repeat(n) + l.trimStart()).join('\n');

async function once(root: string, opts: Options, config: any): Promise<boolean> {
    const include = Array.isArray(config.include) ? config.include.map(globRe) : null;
    const exclude = Array.isArray(config.exclude) ? config.exclude.map(globRe) : [];
    let files = findTests(root, (rel) => (include ? include.some((re: RegExp) => re.test(rel)) : DEFAULT_INCLUDE.test(rel)), (rel) => exclude.some((re: RegExp) => re.test(rel)));
    if (opts.filters.length) files = files.filter((f) => opts.filters.some((q) => f.includes(path.resolve(root, q)) || path.relative(root, f).split(path.sep).join('/').includes(q)));
    if (!files.length) {
        console.log(opts.passWithNoTests ? 'No test files found.' : red('No test files found.'));
        return opts.passWithNoTests;
    }
    const started = performance.now();
    const { environmentOf } = await import('./environment.js');
    const setupFiles = (Array.isArray(config.setupFiles) ? config.setupFiles : config.setupFiles ? [config.setupFiles] : []).map((f: string) => path.resolve(root, f));
    const coverage = opts.coverage || config.coverage === true || config.coverage?.enabled === true;
    // Browser mode: `--browser`, or `test.browser` ({ enabled, name, headless }) in lunx.config.
    const browserConfig = config.browser === true ? { enabled: true } : config.browser;
    const browser = opts.browser ?? (browserConfig?.enabled ? browserConfig.name ?? 'chromium' : undefined);
    if (browser) {
        const { runInBrowsers } = await import('./browser.js');
        const results = await runInBrowsers(root, files, {
            name: browser,
            headless: !opts.headed && browserConfig?.headless !== false,
            executablePath: browserConfig?.executablePath,
            update: opts.update,
            ci: opts.ci,
            testNamePattern: opts.testNamePattern,
            setupFiles,
        }, (r) => printFile(root, r));
        return summarize(results, started, false, config, root);
    }
    const queue = [...files];
    const results: FileResult[] = [];
    let stop = false;
    const pool = Math.max(1, Math.min(files.length, (os.availableParallelism?.() ?? os.cpus().length) - 1 || 1));
    await Promise.all(Array.from({ length: pool }, async () => {
        for (let file = queue.shift(); file && !stop; file = queue.shift()) {
            const r = await runFile({
                file,
                root,
                environment: environmentOf(file, (config.environment as Options['environment']) ?? opts.environment),
                update: opts.update,
                ci: opts.ci,
                coverage,
                testNamePattern: opts.testNamePattern,
                setupFiles,
            });
            results.push(r);
            printFile(root, r);
            if (opts.bail && (r.error || r.tests.some((t) => t.status === 'fail'))) stop = true;
        }
    }));
    return summarize(results, started, coverage, config, root);
}

async function summarize(results: FileResult[], started: number, coverage: boolean, config: any, root = process.cwd()): Promise<boolean> {
    const tests = results.flatMap((r) => r.tests);
    const count = (s: string) => tests.filter((t) => t.status === s).length;
    const failedFiles = results.filter((r) => r.error || r.tests.some((t) => t.status === 'fail')).length;
    const snaps = results.reduce((a, r) => ({ added: a.added + r.snapshots.added, updated: a.updated + r.snapshots.updated, failed: a.failed + r.snapshots.failed }), { added: 0, updated: 0, failed: 0 });
    const part = (n: number, label: string, paint: (s: string) => string) => (n ? paint(`${n} ${label}`) : '');
    const join = (...xs: string[]) => xs.filter(Boolean).join(dim(' | '));
    console.log(`\n ${dim('Test Files')}  ${join(part(failedFiles, 'failed', red), part(results.length - failedFiles, 'passed', green))} ${dim(`(${results.length})`)}`);
    console.log(` ${dim('     Tests')}  ${join(part(count('fail'), 'failed', red), part(count('pass'), 'passed', green), part(count('skip'), 'skipped', yellow), part(count('todo'), 'todo', dim))} ${dim(`(${tests.length})`)}`);
    if (snaps.added || snaps.updated || snaps.failed) console.log(` ${dim(' Snapshots')}  ${join(part(snaps.failed, 'failed', red), part(snaps.added, 'written', green), part(snaps.updated, 'updated', green))}`);
    console.log(` ${dim('  Duration')}  ${Math.round(performance.now() - started)}ms\n`);
    if (coverage) {
        const { mergeHits, writeReports } = await import('./coverage.js');
        writeReports(root, mergeHits(results.map((r) => r.coverage)), config.coverage?.reportsDirectory ?? 'coverage');
    }
    return failedFiles === 0;
}

export async function run(args: string[]): Promise<void> {
    const opts = parseArgs(args);
    const root = process.cwd();
    if (!opts.builtin) {
        const vitest = ['node_modules/.bin/vitest', 'node_modules/.bin/vitest.cmd'].some((f) => fs.existsSync(path.join(root, f)));
        if (vitest) {
            console.log(dim('[lunx] Vitest is installed: running it on lunx\'s engine (lunx test --builtin for lunx\'s runner)'));
            const { runExec } = await import('../commands/exec.js');
            const passthrough = args.filter((a) => a !== '--watch' && a !== '-w' && a !== '--run');
            process.exitCode = await runExec(['vitest', ...(opts.watch ? [] : ['run']), ...passthrough], root);
            return;
        }
    }
    const config = await testConfig(root);
    const ok = await once(root, opts, config);
    if (!opts.watch) {
        process.exitCode = ok ? 0 : 1;
        return;
    }
    console.log(dim('Watching for changes…'));
    let timer: NodeJS.Timeout | undefined;
    fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename || /(^|[\\/])(node_modules|\.git|\.lunx|coverage|dist)([\\/]|$)/.test(filename) || /__snapshots__/.test(filename)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            console.log(dim(`\n${filename} changed, running tests…\n`));
            once(root, { ...opts, update: false }, config).catch(console.error);
        }, 100);
    });
}
