/**
 * `import.meta.glob` — Vite's file-system imports, for dev and build.
 *
 *   import.meta.glob('./pages/*.tsx')                       → { './pages/a.tsx': () => import('./pages/a.tsx'), … }
 *   import.meta.glob('./i18n/*.json', { eager: true })      → { './i18n/en.json': <module>, … }
 *   import.meta.glob('./md/*.md', { query: '?raw', import: 'default' })
 *   import.meta.glob(['./a/*.ts', '!./a/skip.ts'])
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../engines/index.js';
import { full } from '../lib/ast-walk.js';

interface GlobOptions {
    eager?: boolean;
    import?: string;
    query?: string | Record<string, string | number | boolean>;
    as?: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.lunx']);

/** Start offsets of `import.meta.glob(…)` calls, or null when the code cannot be parsed (TS/JSX before compiling). */
function callOffsets(code: string, file: string): Set<number> | null {
    let ast: any;
    try {
        ast = parse(file.endsWith('.js') || file.endsWith('.mjs') ? file : 'module.js', code, 'js');
    } catch {
        return null;
    }
    const offsets = new Set<number>();
    full(ast, (node: any) => {
        const callee = node.type === 'CallExpression' ? node.callee : null;
        if (callee?.type === 'MemberExpression' && /^glob(Eager)?$/.test(callee.property?.name ?? '') && callee.object?.type === 'MetaProperty') {
            offsets.add(callee.start);
        }
    });
    return offsets;
}

export function transformGlobImports(code: string, file: string, root: string): string | null {
    if (!code.includes('import.meta.glob')) return null;
    const hoisted: string[] = [];
    let out = '';
    let last = 0;
    let index = 0;
    const re = /import\.meta\.glob(Eager)?\s*(?:<[^>]*>)?\s*\(/g;
    const calls = callOffsets(code, file);
    for (let m = re.exec(code); m; m = re.exec(code)) {
        // Only real calls: not text in comments or strings (Waku documents the pattern in a comment).
        if (calls && !calls.has(m.index)) continue;
        const argsStart = m.index + m[0].length;
        const argsEnd = findClosingParen(code, argsStart);
        if (argsEnd === -1) continue;
        let args: unknown[];
        try {
            // Arguments must be literals (as in Vite); evaluate them as such.
            args = new Function(`return [${code.slice(argsStart, argsEnd)}]`)();
        } catch {
            throw new Error(`${path.relative(root, file)}: import.meta.glob() arguments must be literal values`);
        }
        const patterns = ([] as string[]).concat(args[0] as string | string[]);
        const options: GlobOptions = { ...((args[1] as GlobOptions) ?? {}) };
        if (m[1]) options.eager = true;
        if (options.as && !options.query) options.query = options.as === 'url' || options.as === 'raw' ? `?${options.as}` : options.as;

        const files = expandGlobs(patterns, file, root);
        const query = typeof options.query === 'string'
            ? (options.query.startsWith('?') ? options.query : `?${options.query}`)
            : options.query ? `?${new URLSearchParams(Object.entries(options.query).map(([k, v]) => [k, String(v)])).toString()}` : '';
        const entries = files.map(({ key, spec }, i) => {
            const full = JSON.stringify(spec + query);
            if (options.eager) {
                const local = `__lunx_glob_${index}_${i}`;
                hoisted.push(options.import && options.import !== '*'
                    ? `import { ${options.import === 'default' ? 'default' : options.import} as ${local} } from ${full};`
                    : `import * as ${local} from ${full};`);
                return `${JSON.stringify(key)}: ${local}`;
            }
            const pick = options.import && options.import !== '*' ? `.then((m) => m[${JSON.stringify(options.import)}])` : '';
            return `${JSON.stringify(key)}: () => import(${full})${pick}`;
        });
        out += code.slice(last, m.index) + `/* #__PURE__ */ Object.assign({ ${entries.join(', ')} })`;
        last = argsEnd + 1;
        re.lastIndex = last;
        index++;
    }
    if (index === 0) return null;
    return hoisted.join('\n') + (hoisted.length ? '\n' : '') + out + code.slice(last);
}

function findClosingParen(code: string, from: number): number {
    let depth = 1;
    let quote: string | null = null;
    for (let i = from; i < code.length; i++) {
        const c = code[i]!;
        if (quote) {
            if (c === '\\') i++;
            else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return i;
    }
    return -1;
}

/** Match patterns relative to the importer (`./`, `../`) or the root (`/`). */
function expandGlobs(patterns: string[], importer: string, root: string): Array<{ key: string; spec: string }> {
    const dir = path.dirname(importer);
    const include = patterns.filter((p) => !p.startsWith('!'));
    const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => toRegExp(absolutePattern(p.slice(1), dir, root)));
    const found = new Map<string, { key: string; spec: string }>();
    for (const pattern of include) {
        const abs = absolutePattern(pattern, dir, root);
        const matcher = toRegExp(abs);
        const base = staticBase(abs);
        for (const file of walk(base)) {
            const posix = file.split(path.sep).join('/');
            if (!matcher.test(posix) || exclude.some((x) => x.test(posix)) || file === importer) continue;
            const key = pattern.startsWith('/')
                ? '/' + path.relative(root, file).split(path.sep).join('/')
                : relativeSpec(dir, file);
            found.set(file, { key, spec: relativeSpec(dir, file) });
        }
    }
    return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function absolutePattern(pattern: string, dir: string, root: string): string {
    const abs = pattern.startsWith('/') ? path.join(root, pattern) : path.resolve(dir, pattern);
    return abs.split(path.sep).join('/');
}

function relativeSpec(dir: string, file: string): string {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    return rel.startsWith('.') ? rel : `./${rel}`;
}

function staticBase(pattern: string): string {
    const parts = pattern.split('/');
    const idx = parts.findIndex((p) => /[*?{[]/.test(p));
    return (idx === -1 ? parts.slice(0, -1) : parts.slice(0, idx)).join('/') || '/';
}

function* walk(dir: string): Generator<string> {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
        } else if (entry.isFile()) yield full;
    }
}

function toRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**/` matches zero or more directories
                re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
                i += glob[i + 2] === '/' ? 2 : 1;
            } else re += '[^/]*';
        } else if (c === '?') re += '[^/]';
        else if (c === '{') {
            const end = glob.indexOf('}', i);
            re += `(?:${glob.slice(i + 1, end).split(',').map(escape).join('|')})`;
            i = end;
        } else re += escape(c);
    }
    return new RegExp(`^${re}$`);
}

function escape(s: string): string {
    return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
