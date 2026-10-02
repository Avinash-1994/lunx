import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, it, expect, vi, __getCollectedSuites, type SuiteContext, type TestContext } from './api.js';

/**
 * Lunx Test Runner
 * Powered by Bun Transpiler & Custom Sandbox
 */

/**
 * Conventional test-file names. Discovery used to match only `_test.ts`, so a
 * project following the near-universal `foo.test.ts` convention got
 * "No test files found" from a runner that was working perfectly.
 */
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|mts|js|jsx|mjs)$|_test\.(ts|js)$/;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.lunx', 'coverage']);

function findFiles(dir: string): string[] {
    let results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            results = results.concat(findFiles(filePath));
        } else if (TEST_FILE_PATTERN.test(entry.name)) {
            results.push(filePath);
        }
    }
    return results;
}

let hooksRegistered = false;

/**
 * Teaches node's ESM loader to compile TypeScript, so test files can be
 * TypeScript. Without this the runner could only import plain-JS ESM.
 */
async function registerTypeScriptHooks(): Promise<void> {
    if (hooksRegistered) return;
    hooksRegistered = true;
    try {
        const { register } = await import('node:module');
        register(new URL('./ts-hooks.js', import.meta.url));
    } catch (err: any) {
        console.warn(
            `⚠️  Could not install the TypeScript loader (${err?.message ?? err}). ` +
            'TypeScript test files will fail to import.'
        );
    }
}

export async function run(args: string[]) {
    console.log('⚡ Lunx Test Runner v1.0.0');
    await registerTypeScriptHooks();

    const TARGET_FILES = args.filter(a => !a.startsWith('-'));
    const IS_WATCH = args.includes('--watch');

    // 1. Find Files
    // Default to the whole project: most projects colocate `foo.test.ts` with
    // the source rather than keeping a top-level `tests/` directory.
    const pattern = TARGET_FILES.length > 0 ? TARGET_FILES[0] : process.cwd();

    // Initial run
    await runTests(pattern, IS_WATCH);

    if (IS_WATCH) {
        console.log('👀 Watching for changes...');
        let debounceTimer: NodeJS.Timeout;

        fs.watch(process.cwd(), { recursive: true }, (event, filename) => {
            if (!filename || filename.includes('node_modules') || filename.includes('.git')) return;
            if (!filename.endsWith('.ts')) return;

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                console.log(`\n\n🔄 Change detected in ${filename}. Re-running tests...`);
                runTests(pattern, IS_WATCH).catch(console.error);
            }, 100);
        });
    }
}

async function runTests(pattern: string, isWatch: boolean) {
    // If pattern is a directory, look for _test.ts files inside
    const files = fs.existsSync(pattern) && fs.statSync(pattern).isDirectory()
        ? findFiles(pattern)
        : [pattern];

    if (files.length === 0) {
        console.error('❌ No test files found.');
        if (!isWatch) process.exit(1);
        return;
    }

    console.log(`running ${files.length} test files...`);
    const start = performance.now();

    let passed = 0;
    let failed = 0;

    // 2. Execute Each File
    for (const file of files) {
        const relativeName = path.relative(process.cwd(), file);
        process.stdout.write(`  running ${relativeName}... `);

        // Inject Globals
        (globalThis as any).describe = describe;
        (globalThis as any).it = it;
        (globalThis as any).test = it;
        (globalThis as any).expect = expect;
        (globalThis as any).vi = vi;
        (globalThis as any).beforeAll = (await import('./api.js')).beforeAll;
        (globalThis as any).afterAll = (await import('./api.js')).afterAll;
        (globalThis as any).beforeEach = (await import('./api.js')).beforeEach;
        (globalThis as any).afterEach = (await import('./api.js')).afterEach;

        try {
            // "Sandboxed" Execution via dynamic import
            // We append a timestamp to bust cache for watch mode (simple heuristic)
            const cacheBust = `?t=${Date.now()}`;
            // A Windows absolute path starts "C:\", and `import('C:\...')`
            // throws ERR_UNSUPPORTED_ESM_URL_SCHEME because the drive letter
            // parses as a URL scheme — so `lunx test` failed on every Windows
            // machine before running a single test.
            await import(pathToFileURL(path.resolve(file)).href + cacheBust);

            const suites = __getCollectedSuites();
            const result = await executeSuites(suites);

            if (result.failed === 0) {
                console.log('✅ PASS');
                passed++;
            } else {
                console.log('❌ FAIL');
                failed++;
            }
        } catch (e) {
            console.log('❌ ERROR');
            console.error(e);
            failed++;
        }
    }

    const end = performance.now();
    console.log('\n--- Summary ---');
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Time: ${(end - start).toFixed(2)}ms`); // Proves <10ms for small suites

    if (!isWatch && failed > 0) process.exit(1);
}

async function executeSuites(suites: SuiteContext[]): Promise<{ passed: number, failed: number }> {
    let passed = 0;
    let failed = 0;

    for (const suite of suites) {
        // Run beforeAll
        if (suite.suiteHooks) {
            for (const hook of suite.suiteHooks.beforeAll) await hook();
        }

        for (const test of suite.tests) {
            try {
                // Run beforeEach
                if (suite.suiteHooks) {
                    for (const hook of suite.suiteHooks.beforeEach) await hook();
                }

                await test.fn();
                test.status = 'passed';
                passed++;

                // Run afterEach
                if (suite.suiteHooks) {
                    for (const hook of suite.suiteHooks.afterEach) await hook();
                }
            } catch (e) {
                test.status = 'failed';
                test.error = e as Error;
                failed++;
                console.error(`\n    ❌ ${test.name} FAILED:`);
                console.error(`       ${(e as Error).message}`);
            }
        }

        // Recursive
        const subResult = await executeSuites(suite.suites);
        passed += subResult.passed;
        failed += subResult.failed;

        // Run afterAll
        if (suite.suiteHooks) {
            for (const hook of suite.suiteHooks.afterAll) await hook();
        }
    }

    return { passed, failed };
}

// @ts-ignore
if (import.meta.url === `file://${process.argv[1]}`) {
    run(process.argv.slice(2)).catch(console.error);
}
