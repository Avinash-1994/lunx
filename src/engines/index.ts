/**
 * Engine registry: the compiler and bundler lunx uses. Call sites import
 * from here, never from a specific tool. Defaults: Oxc and Rolldown.
 * A different engine (e.g. lunx's own Rust bundler) registers itself with
 * setBundler / setCompiler and must pass the same conformance suites.
 */

import type { Bundler, CompileOptions, CompileResult, Compiler, Lang } from './types.js';
import { oxcCompiler } from './oxc.js';
import { rolldownBundler } from './rolldown.js';

export * from './types.js';
export { CompileError, langOf } from './oxc.js';

let compiler: Compiler = oxcCompiler;
let bundler: Bundler = rolldownBundler;

export function getCompiler(): Compiler { return compiler; }
export function getBundler(): Bundler { return bundler; }
export function setCompiler(next: Compiler): void { compiler = next; }
export function setBundler(next: Bundler): void { bundler = next; }

export const compile = (file: string, code: string, opts?: CompileOptions): CompileResult => compiler.compile(file, code, opts);
export const minify = (file: string, code: string, opts?: { mangle?: boolean; compress?: boolean }): CompileResult => compiler.minify(file, code, opts);
export const parse = (file: string, code: string, lang?: Lang, sourceType?: 'module' | 'script'): any => compiler.parse(file, code, lang, sourceType);
