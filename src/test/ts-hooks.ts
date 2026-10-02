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

export async function resolve(
    specifier: string,
    context: ResolveContext,
    nextResolve: (s: string, c: ResolveContext) => Promise<ResolveResult>,
): Promise<ResolveResult> {
    // A relative TypeScript specifier resolves on its own; it is the ".js that
    // is really .ts" case node refuses.
    if (specifier.startsWith('.') && context.parentURL) {
        const candidate = new URL(specifier, context.parentURL).href;
        const rewritten = rewriteJsToTs(candidate);
        if (rewritten) return { url: rewritten, shortCircuit: true };
    }

    try {
        return await nextResolve(specifier, context);
    } catch (err) {
        // Extensionless relative imports, also legal in TypeScript.
        if (specifier.startsWith('.') && context.parentURL) {
            const base = new URL(specifier, context.parentURL).href;
            const [withoutQuery, query] = splitQuery(base);
            for (const ext of TS_EXTENSIONS) {
                const filePath = fileURLToPath(withoutQuery) + ext;
                if (existsSync(filePath)) {
                    return { url: pathToFileURL(filePath).href + query, shortCircuit: true };
                }
            }
        }
        throw err;
    }
}

export async function load(
    url: string,
    context: LoadContext,
    nextLoad: (u: string, c: LoadContext) => Promise<LoadResult>,
): Promise<LoadResult> {
    const [base] = splitQuery(url);
    if (!TS_EXTENSIONS.some((ext) => base.endsWith(ext))) {
        return nextLoad(url, context);
    }

    const result = await nextLoad(url, { ...context, format: 'module' });
    const rawSource = result.source;
    let source: string;
    if (typeof rawSource === 'string') {
        source = rawSource;
    } else if (rawSource instanceof Uint8Array) {
        source = Buffer.from(rawSource).toString('utf8');
    } else {
        source = Buffer.from(new Uint8Array(rawSource as ArrayBuffer)).toString('utf8');
    }

    const filename = fileURLToPath(base);
    const isTsx = base.endsWith('.tsx');
    const swc = require('@swc/core');
    const { code } = swc.transformSync(source, {
        filename,
        jsc: {
            parser: { syntax: 'typescript', tsx: isTsx, decorators: true },
            target: 'es2022',
            // Automatic, so a test file rendering JSX needs no React import.
            transform: isTsx ? { react: { runtime: 'automatic' } } : undefined,
        },
        // Tests run as ESM: the runner imports them by URL.
        module: { type: 'es6' },
        sourceMaps: 'inline',
        isModule: true,
    });

    return { format: 'module', source: code, shortCircuit: true };
}
