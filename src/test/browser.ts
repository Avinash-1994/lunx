/**
 * `lunx test --browser` (or `test.browser` in lunx.config, Vitest's shape):
 * the test files run in a real browser through the project's Playwright.
 * They are bundled with Rolldown in one build (an entry per file, shared
 * chunks) with lunx's test API and the same test walk as the worker; each
 * file runs in a page of its own and reports back. Snapshot files are read
 * before and written after, by the runner.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { FileResult } from './worker.js';

export interface BrowserOptions {
    /** chromium (default), firefox or webkit. */
    name: 'chromium' | 'firefox' | 'webkit';
    headless: boolean;
    /** A browser binary of its own (`test.browser.executablePath`, or CHROMIUM_PATH for Chromium). */
    executablePath?: string;
    update: boolean;
    ci: boolean;
    testNamePattern?: string;
    setupFiles: string[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = (rel: string) => path.join(here, rel);

const ASSET = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|txt)$/i;

function playwright(root: string): any {
    const req = createRequire(path.join(root, 'package.json'));
    for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
        try {
            return req(name);
        } catch {
            // next
        }
    }
    throw new Error('lunx test --browser runs the tests through Playwright: npm i -D playwright && npx playwright install chromium');
}

export async function runInBrowsers(root: string, files: string[], opts: BrowserOptions, onResult: (r: FileResult) => void): Promise<FileResult[]> {
    const pw = playwright(root);
    const { getBundler } = await import('../engines/index.js');
    const shims = { 'node:util': runtime('browser/util.js'), 'node:fs': runtime('browser/fs.js'), 'node:path': runtime('browser/path.js') };
    const api = runtime('api.js');
    const preact = fs.existsSync(path.join(root, 'node_modules', 'preact')) && !fs.existsSync(path.join(root, 'node_modules', 'react'));
    const VIRTUAL = '\0lunx-browser-test:';
    const entries = new Map<string, string>(); // entry name → code
    const input: Record<string, string> = {};
    files.forEach((file, i) => {
        const name = `test-${i}`;
        const data = { file, update: opts.update, ci: opts.ci, testNamePattern: opts.testNamePattern };
        entries.set(VIRTUAL + name, [
            `import { runInBrowser } from ${JSON.stringify(runtime('browser/entry.js'))};`,
            `runInBrowser(${JSON.stringify(data)}, [${opts.setupFiles.map((s) => `() => import(${JSON.stringify(s)})`).join(', ')}], () => import(${JSON.stringify(file)}));`,
        ].join('\n'));
        input[name] = VIRTUAL + name;
    });

    const output = await getBundler().bundle({
        input,
        cwd: root,
        platform: 'browser',
        quiet: true,
        alias: { ...shims, util: shims['node:util'], fs: shims['node:fs'], path: shims['node:path'], vitest: api, '@jest/globals': api, 'lunx-dev/test': api },
        extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
        conditions: ['browser', 'import', 'module', 'development', 'default'],
        define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env.MODE': '"test"', 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false', 'import.meta.vitest': 'undefined' },
        jsx: { runtime: 'automatic', ...(preact ? { importSource: 'preact' } : {}) },
        plugins: [{
            name: 'lunx:browser-test',
            resolveId: { filter: { id: /^\0lunx-browser-test:/ }, handler: (id: string) => id },
            load: {
                filter: { id: /^\0lunx-browser-test:|\.(css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|txt)(\?.*)?$/i },
                handler(id: string) {
                    if (entries.has(id)) return entries.get(id)!;
                    const file = id.split('?')[0]!;
                    if (file.endsWith('.css')) {
                        const css = fs.readFileSync(file, 'utf8');
                        return { code: `const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); export default ${JSON.stringify(css)};`, moduleType: 'js' };
                    }
                    if (ASSET.test(file)) return { code: `export default ${JSON.stringify('/@fs' + file.split(path.sep).join('/'))};`, moduleType: 'js' };
                    return null;
                },
            },
        }],
        onWarning: (w) => !['EVAL', 'CIRCULAR_DEPENDENCY', 'MIXED_EXPORT', 'EMPTY_IMPORT_META'].includes(w.code ?? ''),
    }, { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', sourcemap: true }, false);

    const served = new Map<string, string>();
    for (const o of output) served.set('/' + o.fileName, o.type === 'chunk' ? o.code : String(o.source));
    const pages = new Map<string, string>(); // `/page-<i>.html` → html
    files.forEach((file, i) => {
        const snapFile = path.join(path.dirname(file), '__snapshots__', path.basename(file) + '.snap');
        const known: Record<string, string> = {};
        for (const f of [snapFile, file]) if (fs.existsSync(f)) known[f] = fs.readFileSync(f, 'utf8');
        const json = JSON.stringify(known).replace(/</g, '\\u003c');
        pages.set(`/page-${i}.html`, `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__lunx_files = ${json};</script><script type="module" src="/test-${i}.js"></script></head><body></body></html>`);
    });
    const server = http.createServer((req, res) => {
        const url = decodeURIComponent((req.url || '/').split('?')[0]!);
        const page = pages.get(url);
        if (page) return void res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
        const code = served.get(url);
        if (code !== undefined) return void res.writeHead(200, { 'Content-Type': url.endsWith('.map') ? 'application/json' : 'application/javascript' }).end(code);
        if (url.startsWith('/@fs/')) {
            const file = url.slice(4);
            if (file.startsWith(root) && fs.existsSync(file)) {
                const type = file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
                return void res.writeHead(200, { 'Content-Type': type }).end(fs.readFileSync(file));
            }
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port as number;

    const browserType = pw[opts.name];
    if (!browserType) throw new Error(`unknown browser "${opts.name}" (chromium, firefox or webkit)`);
    const launchOptions: any = { headless: opts.headless };
    const executablePath = opts.executablePath ?? (opts.name === 'chromium' ? process.env.CHROMIUM_PATH : undefined);
    if (executablePath) launchOptions.executablePath = executablePath;
    let browser: any;
    try {
        browser = await browserType.launch(launchOptions);
    } catch (err: any) {
        server.close();
        throw new Error(`${opts.name} did not start: ${String(err?.message ?? err).split('\n')[0]}\n  Install it (npx playwright install ${opts.name}), or point test.browser.executablePath${opts.name === 'chromium' ? ' (or CHROMIUM_PATH)' : ''} at one.`);
    }
    const results: FileResult[] = [];
    try {
        const context = await browser.newContext();
        const queue = files.map((file, i) => ({ file, i }));
        await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
            for (let job = queue.shift(); job; job = queue.shift()) {
                const page = await context.newPage();
                const errors: string[] = [];
                page.on('pageerror', (e: Error) => errors.push(e.stack ?? e.message));
                const result = await new Promise<FileResult>((resolve) => {
                    const timer = setTimeout(() => resolve(failed(job!.file, errors.length ? errors.join('\n') : 'no result from the page after 60 s')), 60_000);
                    void page.exposeFunction('__lunx_done', (r: FileResult & { writes: Record<string, string | null> }) => {
                        clearTimeout(timer);
                        for (const [file, content] of Object.entries(r.writes ?? {})) {
                            if (!path.resolve(file).startsWith(root + path.sep)) continue;
                            if (content === null) fs.rmSync(file, { force: true });
                            else {
                                fs.mkdirSync(path.dirname(file), { recursive: true });
                                fs.writeFileSync(file, content);
                            }
                        }
                        resolve({ file: r.file, tests: r.tests, error: r.error, snapshots: r.snapshots, coverage: [], duration: r.duration });
                    }).then(() => page.goto(`http://127.0.0.1:${port}/page-${job!.i}.html`)).catch((e: Error) => {
                        clearTimeout(timer);
                        resolve(failed(job!.file, e.message));
                    });
                });
                await page.close();
                results.push(result);
                onResult(result);
            }
        }));
    } finally {
        await browser.close();
        server.close();
    }
    return results;
}

function failed(file: string, message: string): FileResult {
    return { file, tests: [], error: { message }, snapshots: { added: 0, updated: 0, matched: 0, failed: 0 }, coverage: [], duration: 0 };
}
