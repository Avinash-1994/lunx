/**
 * CommonJS modules with a static shape, rewritten as ES modules before
 * Rolldown parses them, so it can drop the exports an app never imports
 * (Rolldown keeps a CommonJS module's body whole; Bun tree-shakes inside it).
 * React, ReactDOM and the scheduler are the case that matters: their
 * production builds are a list of `exports.name = …` assignments.
 *
 * Two shapes are rewritten; anything else is left to Rolldown's CommonJS
 * interop:
 *  - an exports module: `require()` only in top-level `var x = require('…')`,
 *    `exports` only as `exports.name`, no `module`, no top-level `this`.
 *    Each `exports.name` becomes a module variable exported as `name` (a live
 *    binding, as the property was); each `require` an `import * as`.
 *    `export default` is an object of every export, for `import React from 'react'`.
 *  - an entry module: `module.exports = require('…')` under
 *    `if (process.env.NODE_ENV === 'production')`, beside local functions
 *    and calls to them (React's `checkDCE`). It re-exports the branch for
 *    the build's mode.
 */
import { lexExportsModule } from './cjs-lexer.js';
import { requireEsm } from '../engines/require-esm.js';

// Loaded on first use: the lexer handles large modules without it, and the prefetch worker
// (cjs-prefetch.ts) starts faster without Rolldown's binding.
let parseAst: ((code: string, options: object, file: string) => unknown) | null = null;

/** Above this size an exports module is read by the lexer first (cjs-lexer.ts): no JS syntax tree. */
const LEX_ABOVE = 32 * 1024;

type Node = { type: string; start: number; end: number; [key: string]: any };

interface Edit {
    start: number;
    end: number;
    text: string;
}

// Functions that bind `this` (an arrow's `this` is its scope's: at the top level, the module's).
const FUNCTION = /^(FunctionDeclaration|FunctionExpression)$/;

/**
 * The file `module.exports` comes from in an entry like React's, for `mode`:
 * `if (process.env.NODE_ENV === 'production') { …; module.exports = require(prod) } else { module.exports = require(dev) }`.
 */
export function nodeEnvSwitch(code: string, mode: string): string | null {
    const m = /if\s*\(process\.env\.NODE_ENV\s*===\s*['"]production['"]\)\s*\{[^{}]*?module\.exports\s*=\s*require\(['"]([^'"]+)['"]\);?\s*\}\s*else\s*\{\s*module\.exports\s*=\s*require\(['"]([^'"]+)['"]\);?\s*\}\s*$/.exec(code);
    if (!m || (code.match(/\bmodule\.exports\b/g) ?? []).length !== 2) return null;
    return mode === 'production' ? m[1]! : m[2]!;
}

/** Quick test before parsing: CommonJS markers, and no ES module syntax. */
export function mayConvert(code: string): boolean {
    return /\bexports\b|\bmodule\.exports\b/.test(code) && !/^\s*(import|export)\s/m.test(code);
}

/** The ES module for `code`, or null when it is not one of the static shapes. */
export function cjsToEsm(code: string, file: string, mode: string): string | null {
    if (code.length > LEX_ABOVE) {
        const lexed = exportsModuleByLexer(code);
        if (lexed !== undefined) return lexed;
    }
    return cjsToEsmByTree(code, file, mode);
}

/** The exports-module conversion from tokens: undefined when the lexer is unsure (cjs-lexer.ts). */
export function exportsModuleByLexer(code: string): string | null | undefined {
    const lexed = lexExportsModule(code);
    if (!lexed) return lexed;
    const edits: Edit[] = lexed.requires.map((r) => ({ start: r.start, end: r.end, text: code.slice(r.start, r.end).replace(/[^\n]/g, '') }));
    for (const r of lexed.requires) for (const b of r.bindings) if (namespaceAssigned(code, b.name, edits)) return null;
    for (const ref of lexed.exportRefs) edits.push({ start: ref.start, end: ref.end, text: `__exp_${ref.name}` });
    const imports = lexed.requires.flatMap((r) => r.bindings.map((b) => `import * as ${b.name} from ${JSON.stringify(b.spec)};`));
    return assemble(code, imports, edits, new Set(lexed.exportRefs.map((r) => r.name)));
}

/** Both shapes, from the syntax tree. */
export function cjsToEsmByTree(code: string, file: string, mode: string): string | null {
    let ast: Node;
    try {
        parseAst ??= requireEsm('rolldown/parseAst').parseAst as typeof parseAst;
        ast = parseAst!(code, { sourceType: 'script' }, file) as unknown as Node;
    } catch {
        return null;
    }
    return entryModule(ast, code, mode) ?? exportsModule(ast, code);
}

type Visit = (n: Node, parent: Node | null, fnDepth: number) => boolean | 'skip' | void;

/**
 * Depth-first; the visitor returns 'skip' to leave a node's children, false to stop.
 * `relevant(start, end, fnDepth)` false: nothing in that node's range can matter, so its
 * subtree is not visited (react-dom's 500 kB walk in ~5 ms instead of ~80).
 */
function walk(node: any, visit: Visit, relevant: (start: number, end: number, fnDepth: number) => boolean, parent: Node | null = null, fnDepth = 0): boolean {
    if (!node || typeof node.type !== 'string' || !relevant(node.start, node.end, fnDepth)) return true;
    const verdict = visit(node, parent, fnDepth);
    if (verdict === false) return false;
    if (verdict === 'skip') return true;
    const depth = FUNCTION.test(node.type) ? fnDepth + 1 : fnDepth;
    for (const key in node) {
        if (key === 'type' || key === 'start' || key === 'end') continue;
        const value = node[key];
        if (value === null || typeof value !== 'object') continue;
        if (Array.isArray(value)) {
            for (const child of value) if (child && typeof child.type === 'string' && !walk(child, visit, relevant, node, depth)) return false;
        } else if (typeof value.type === 'string') {
            if (!walk(value, visit, relevant, node, depth)) return false;
        }
    }
    return true;
}

/** Sorted offsets where `re` matches `code`. */
function offsets(code: string, re: RegExp): number[] {
    const out: number[] = [];
    for (const m of code.matchAll(re)) out.push(m.index!);
    return out;
}

/** Whether a sorted list has an offset in [start, end). */
function within(list: number[], start: number, end: number): boolean {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]! < start) lo = mid + 1;
        else hi = mid;
    }
    return lo < list.length && list[lo]! < end;
}

const isRequire = (n: any): n is Node =>
    n?.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'require' && n.arguments.length === 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string';

const isUseStrict = (s: any) => s.type === 'ExpressionStatement' && s.directive === 'use strict';

/** `process.env.NODE_ENV === 'production'` (either order, == or ===, or their negations): its value for `mode`, or undefined. */
function nodeEnvTest(test: any, mode: string): boolean | undefined {
    if (test?.type !== 'BinaryExpression' || !/^[!=]==?$/.test(test.operator)) return undefined;
    const isEnv = (n: any) => n?.type === 'MemberExpression' && !n.computed && n.property.name === 'NODE_ENV' && n.object?.type === 'MemberExpression' && !n.object.computed && n.object.property.name === 'env' && n.object.object?.type === 'Identifier' && n.object.object.name === 'process';
    const lit = isEnv(test.left) ? test.right : isEnv(test.right) ? test.left : null;
    if (lit?.type !== 'Literal' || typeof lit.value !== 'string') return undefined;
    const equal = mode === lit.value;
    return test.operator.startsWith('=') ? equal : !equal;
}

function entryModule(ast: Node, code: string, mode: string): string | null {
    const out: string[] = [];
    const locals = new Set<string>();
    let target: string | null = null;
    const statement = (s: any): boolean => {
        if (isUseStrict(s) || s.type === 'EmptyStatement') return true;
        if (s.type === 'FunctionDeclaration' && s.id) {
            locals.add(s.id.name);
            out.push(code.slice(s.start, s.end));
            return true;
        }
        if (s.type === 'ExpressionStatement' && s.expression.type === 'CallExpression' && s.expression.callee.type === 'Identifier' && locals.has(s.expression.callee.name) && !s.expression.arguments.length) {
            out.push(code.slice(s.start, s.end));
            return true;
        }
        const e = s.type === 'ExpressionStatement' ? s.expression : null;
        if (e?.type === 'AssignmentExpression' && e.operator === '=' && e.left.type === 'MemberExpression' && !e.left.computed && e.left.object.name === 'module' && e.left.property.name === 'exports' && isRequire(e.right)) {
            if (target) return false;
            target = e.right.arguments[0].value;
            return true;
        }
        if (s.type === 'BlockStatement') return s.body.every(statement);
        if (s.type === 'IfStatement') {
            const branch = nodeEnvTest(s.test, mode);
            if (branch === undefined) return false;
            const taken = branch ? s.consequent : s.alternate;
            return !taken || statement(taken);
        }
        return false;
    };
    if (!ast.body.length || !ast.body.every(statement) || !target) return null;
    const spec = JSON.stringify(target);
    return `export * from ${spec};\nexport { default } from ${spec};\n${out.join('\n')}\n`;
}

function exportsModule(ast: Node, code: string): string | null {
    const edits: Edit[] = [];
    const imports: string[] = [];
    const names = new Set<string>();
    let ok = true;
    // `require`: only as top-level `var x = require('…'), y = require('…');`, each becoming
    // `import * as x` (member accesses then resolve statically; a namespace assigned to a
    // variable would keep every export). The names must not be declared or assigned again.
    const allowedRequires = new Set<Node>();
    const namespaces = new Set<string>();
    const topLevel = new Map<string, number>();
    const declare = (name: string) => topLevel.set(name, (topLevel.get(name) ?? 0) + 1);
    // The requires come first (imports run before the module's code; a require after other
    // statements could depend on what they did).
    let pastRequires = false;
    for (const s of ast.body) {
        if (isUseStrict(s)) continue;
        if (s.type === 'VariableDeclaration') {
            for (const d of s.declarations) if (d.id.type === 'Identifier') declare(d.id.name);
            if (s.declarations.some((d: any) => isRequire(d.init))) {
                if (pastRequires || !s.declarations.every((d: any) => isRequire(d.init) && d.id.type === 'Identifier')) return null;
                const lines = s.declarations.map((d: any) => {
                    allowedRequires.add(d.init);
                    namespaces.add(d.id.name);
                    return `import * as ${d.id.name} from ${JSON.stringify(d.init.arguments[0].value)};`;
                });
                imports.push(...lines);
                // Blank lines in its place: the module's lines keep their numbers.
                edits.push({ start: s.start, end: s.end, text: code.slice(s.start, s.end).replace(/[^\n]/g, '') });
                continue;
            }
        } else if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) declare(s.id.name);
        pastRequires = true;
    }
    for (const name of namespaces) if (topLevel.get(name) !== 1) return null;
    for (const name of namespaces) if (namespaceAssigned(code, name, edits)) return null;
    // Only nodes whose source holds one of the names below (or, outside functions, `this`)
    // can fail the checks or need an edit. Escaped identifiers (\u0065xports) defeat the
    // text search: those modules are walked whole.
    const idAt = offsets(code, /(?<![\w$])(?:module|require|exports|__esModule)(?![\w$])/g);
    const thisAt = offsets(code, /(?<![\w$.])this(?![\w$])/g);
    const escaped = /\\u[0-9a-fA-F{]/.test(code);
    const relevant = (start: number, end: number, fnDepth: number) => escaped || within(idAt, start, end) || (fnDepth === 0 && within(thisAt, start, end));
    walk(ast, (n, parent, fnDepth) => {
        if (n.type === 'Identifier') {
            const isProp = parent?.type === 'MemberExpression' && parent.property === n && !parent.computed;
            const isKey = parent?.type === 'Property' && parent.key === n && !parent.computed;
            if (isProp || isKey) return;
            if (n.name === 'module' || n.name === 'require' || n.name === 'exports' || n.name === '__esModule') {
                // Declared or used any other way: not a static module.
                if (n.name === 'require' && parent && allowedRequires.has(parent)) return;
                if (n.name === 'exports' && parent?.type === 'MemberExpression' && parent.object === n && !parent.computed) return;
                ok = false;
                return false;
            }
        }
        if (n.type === 'ThisExpression' && fnDepth === 0) {
            ok = false;
            return false;
        }
        if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'exports') {
            const name = n.property.name as string;
            if (name === '__esModule' || name === 'default') {
                ok = false;
                return false;
            }
            names.add(name);
            edits.push({ start: n.start, end: n.end, text: `__exp_${name}` });
            return 'skip';
        }
        if (n.type === 'VariableDeclaration' && n.declarations.some((d: any) => allowedRequires.has(d.init))) return 'skip';
    }, relevant);
    if (!ok) return null;
    return assemble(code, imports, edits, names);
}

/**
 * Whether a namespace is assigned (`React = …`, `React++`), which leaves it a variable: not
 * static. Searched in the text without the require declarations in `skip`; a match in a
 * string only gives up early.
 */
function namespaceAssigned(code: string, name: string, skip: Edit[]): boolean {
    let rest = code;
    for (const e of skip) rest = rest.slice(0, e.start) + ' '.repeat(e.end - e.start) + rest.slice(e.end);
    return new RegExp(`(^|[^.\\w$])${name}\\s*(=(?![=>])|[-+*/%&|^]=|\\*\\*=|<<=|>>>?=|&&=|\\|\\|=|\\?\\?=|\\+\\+|--)|(\\+\\+|--)\\s*${name}(?![\\w$])`).test(rest);
}

/** The ES module: the imports and export variables on the first line (line numbers stay), the body with `edits`, the exports. */
function assemble(code: string, imports: string[], edits: Edit[], names: Set<string>): string | null {
    if (!names.size) return null;
    edits.sort((a, b) => a.start - b.start);
    const parts: string[] = [];
    let at = 0;
    for (const e of edits) {
        parts.push(code.slice(at, e.start), e.text);
        at = e.end;
    }
    parts.push(code.slice(at));
    const body = parts.join('');
    const list = [...names];
    // Imports and the export variables share the first line, so line numbers stay as they were.
    return (
        imports.join(' ') +
        ` var ${list.map((n) => `__exp_${n}`).join(', ')};` +
        body +
        `\nexport { ${list.map((n) => `__exp_${n} as ${n}`).join(', ')} };\n` +
        `export default { ${list.map((n) => `${JSON.stringify(n)}: __exp_${n}`).join(', ')} };\n`
    );
}
