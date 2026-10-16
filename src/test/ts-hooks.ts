/**
 * Node ESM loader hooks that let `lunx test` run TypeScript test files.
 *
 * The runner imported test files straight through node's ESM loader, which
 * cannot parse TypeScript, so `lunx test` could only ever run plain-JS ESM
 * tests — in a tool whose whole pitch is first-class TypeScript. These hooks
 * compile .ts/.tsx on load with the same SWC path the bundler uses, and
 * implement TypeScript's "import the .js, resolve the .ts" convention.
 *
 * Registered from runner.ts via `module.register()`; they run on their own
 * thread, so nothing here may depend on the runner's state.
 */

import { createRequire } from 'node:module';
import { compile } from '../engines/index.js';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

interface ResolveContext {
    parentURL?: string;
    conditions: string[];
    importAttributes?: Record<string, string>;
}
interface ResolveResult {
    url: string;
    format?: string | null;
    shortCircuit?: boolean;
}
interface LoadContext {
    format?: string | null;
    conditions: string[];
    importAttributes?: Record<string, string>;
}
interface LoadResult {
    format: string;
    source?: string | ArrayBuffer | Uint8Array;
    shortCircuit?: boolean;
}

/** `./sum.js` in a TypeScript source means `./sum.ts` on disk. */
function rewriteJsToTs(url: string): string | null {
    if (!/\.(js|jsx|mjs|cjs)(\?|$)/.test(url)) return null;
    const [base, query] = splitQuery(url);
    let filePath: string;
    try {
        filePath = fileURLToPath(base);
    } catch {
        return null;
    }
    if (existsSync(filePath)) return null;

    const withoutExt = filePath.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const ext of TS_EXTENSIONS) {
        if (existsSync(withoutExt + ext)) {
            return pathToFileURL(withoutExt + ext).href + query;
        }
    }
    return null;
}

function splitQuery(url: string): [string, string] {
    const i = url.indexOf('?');
    return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i)];
}

const TEST_API = new Set(['vitest', '@jest/globals', 'lunx-dev/test']);

function resolveWith<T>(
    specifier: string,
    context: ResolveContext,
    next: () => T,
    then: (value: T, fallback: (err: unknown) => ResolveResult) => T | ResolveResult,
): T | ResolveResult {
    // Tests written against Vitest's or Jest's API run on lunx's: under lunx test, these are lunx's.
    if (TEST_API.has(specifier)) return { url: new URL('./api.js', import.meta.url).href, shortCircuit: true };
    // A relative TypeScript specifier resolves on its own; it is the ".js that
    // is really .ts" case node refuses.
    if (specifier.startsWith('.') && context.parentURL) {
        const rewritten = rewriteJsToTs(new URL(specifier, context.parentURL).href);
        if (rewritten) return { url: rewritten, shortCircuit: true };
    }
    const fallback = (err: unknown): ResolveResult => {
        // Extensionless relative imports, also legal in TypeScript.
        if (specifier.startsWith('.') && context.parentURL) {
            const [withoutQuery, query] = splitQuery(new URL(specifier, context.parentURL).href);
            for (const ext of TS_EXTENSIONS) {
                const filePath = fileURLToPath(withoutQuery) + ext;
                if (existsSync(filePath)) return { url: pathToFileURL(filePath).href + query, shortCircuit: true };
            }
        }
        throw err;
    };
    try {
        return then(next(), fallback);
    } catch (err) {
        return fallback(err);
    }
}

export async function resolve(
    specifier: string,
    context: ResolveContext,
    nextResolve: (s: string, c: ResolveContext) => Promise<ResolveResult>,
): Promise<ResolveResult> {
    return resolveWith(specifier, context, () => nextResolve(specifier, context), (p, fallback) => p.catch(fallback)) as Promise<ResolveResult> | ResolveResult;
}

/** Synchronous hooks (`module.registerHooks`, Node ≥ 22.15): in the thread itself, so `require()` of ES modules works. */
export function resolveSync(specifier: string, context: ResolveContext, nextResolve: (s: string, c: ResolveContext) => ResolveResult): ResolveResult {
    return resolveWith(specifier, context, () => nextResolve(specifier, context), (r) => r) as ResolveResult;
}

function compileTs(url: string, rawSource: LoadResult['source']): LoadResult {
    const [base] = splitQuery(url);
    const source = typeof rawSource === 'string' ? rawSource : Buffer.from(rawSource instanceof Uint8Array ? rawSource : new Uint8Array(rawSource as ArrayBuffer)).toString('utf8');
    const isTsx = base.endsWith('.tsx');
    // Automatic JSX, so a test file rendering JSX needs no React import.
    const { code } = compile(fileURLToPath(base), source, {
        lang: isTsx ? 'tsx' : 'ts',
        jsx: isTsx ? { runtime: 'automatic' } : undefined,
        legacyDecorators: true,
        sourcemap: 'inline',
    });
    return { format: url.includes('.cts') ? 'commonjs' : 'module', source: code, shortCircuit: true };
}

const isTs = (url: string) => TS_EXTENSIONS.some((ext) => splitQuery(url)[0].endsWith(ext));

export async function load(url: string, context: LoadContext, nextLoad: (u: string, c: LoadContext) => Promise<LoadResult>): Promise<LoadResult> {
    if (!isTs(url)) return nextLoad(url, context);
    return compileTs(url, (await nextLoad(url, { ...context, format: 'module' })).source);
}

export function loadSync(url: string, context: LoadContext, nextLoad: (u: string, c: LoadContext) => LoadResult): LoadResult {
    if (!isTs(url)) return nextLoad(url, context);
    return compileTs(url, nextLoad(url, { ...context, format: 'module' }).source);
}
