/**
 * The one compiler lunx uses: Oxc, shipped inside Rolldown (already the
 * production bundler). It replaced @swc/core, esbuild and acorn for
 * TypeScript/JSX stripping, React Refresh, decorators, `define`, minifying
 * and parsing, which removed ~40-70 MB of native binaries from an install and
 * the behavioural drift between three compilers.
 */

import path from 'node:path';
import { requireEsm } from './require-esm.js';

const oxc: any = requireEsm('rolldown/experimental');

import type { CompileOptions, CompileResult, Compiler, Lang } from './types.js';

export class CompileError extends Error {
    constructor(public file: string, public details: Array<{ message: string; line?: number; column?: number }>) {
        super(`${path.basename(file)}: ${details.map((d) => d.message).join('; ')}`);
    }
}

export function langOf(file: string): Lang {
    const ext = path.extname(file.split('?')[0]!).toLowerCase();
    if (ext === '.tsx') return 'tsx';
    if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts';
    if (ext === '.jsx') return 'jsx';
    return 'js';
}

/** Strip types, compile JSX, apply defines. Output stays ES modules. */
function compile(file: string, code: string, opts: CompileOptions = {}): CompileResult {
    const result = oxc.transformSync(file, code, {
        lang: opts.lang ?? langOf(file),
        sourceType: 'module',
        sourcemap: !!opts.sourcemap,
        jsx: opts.jsx === 'preserve'
            ? 'preserve'
            : opts.jsx
                ? {
                      runtime: opts.jsx.runtime ?? 'automatic',
                      importSource: opts.jsx.importSource,
                      pragma: opts.jsx.pragma,
                      pragmaFrag: opts.jsx.pragmaFrag,
                      development: opts.jsx.development,
                      refresh: opts.jsx.refresh ? {} : undefined,
                  }
                : undefined,
        decorator: opts.legacyDecorators ? { legacy: true, emitDecoratorMetadata: !!opts.decoratorMetadata } : undefined,
        typescript: { onlyRemoveTypeImports: false },
        define: opts.define && Object.keys(opts.define).length ? opts.define : undefined,
        target: opts.target ?? 'esnext',
        // Helpers are referenced as babelHelpers.x and defined inline below,
        // so output never imports a runtime package the project may not have.
        helpers: { mode: 'External' },
    });
    const errors = (result.errors ?? []).filter((e: any) => e.severity !== 'Warning');
    if (errors.length) {
        throw new CompileError(file, errors.map((e: any) => ({
            message: e.message,
            line: e.labels?.[0]?.start !== undefined ? lineOf(code, e.labels[0].start) : undefined,
        })));
    }
    let out: string = withHelpers(result.code);
    const map = result.map ? JSON.stringify(result.map) : undefined;
    if (opts.sourcemap === 'inline' && map) {
        out += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}`;
    }
    return { code: out, map: opts.sourcemap === 'inline' ? undefined : map };
}

function minify(file: string, code: string, opts: { mangle?: boolean; compress?: boolean } = {}): CompileResult {
    const result = oxc.minifySync(file, code, { mangle: opts.mangle ?? true, compress: opts.compress ?? true });
    return { code: result.code, map: result.map ? JSON.stringify(result.map) : undefined };
}

/** ESTree-compatible AST (node.start / node.end offsets, like acorn). */
function parse(file: string, code: string, lang?: Lang, sourceType: 'module' | 'script' = 'module'): any {
    const result = oxc.parseSync(file, code, { lang: lang ?? langOf(file), sourceType });
    const errors = (result.errors ?? []).filter((e: any) => e.severity !== 'Warning');
    if (errors.length) throw new CompileError(file, errors.map((e: any) => ({ message: e.message })));
    return result.program;
}

/** TypeScript's own decorator helpers (tslib), inlined when used. */
const HELPERS: Record<string, string> = {
    decorate: `function (decorators, target, key, desc) { var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d; if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc); else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r; return c > 3 && r && Object.defineProperty(target, key, r), r; }`,
    decorateMetadata: `function (k, v) { if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v); }`,
    decorateParam: `function (paramIndex, decorator) { return function (target, key) { decorator(target, key, paramIndex); }; }`,
};

function withHelpers(code: string): string {
    if (!code.includes('babelHelpers.')) return code;
    const used = [...new Set([...code.matchAll(/babelHelpers\.(\w+)/g)].map((m) => m[1]!))];
    const missing = used.filter((h) => !HELPERS[h]);
    if (missing.length) throw new Error(`unsupported compiler helper(s): ${missing.join(', ')}`);
    return `const babelHelpers = { ${used.map((h) => `${h}: ${HELPERS[h]}`).join(', ')} };\n${code}`;
}

function lineOf(code: string, offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < code.length; i++) if (code.charCodeAt(i) === 10) line++;
    return line;
}

/** The default `Compiler`. This file is the only place lunx talks to Oxc. */
export const oxcCompiler: Compiler = { name: 'oxc', compile, minify, parse };
