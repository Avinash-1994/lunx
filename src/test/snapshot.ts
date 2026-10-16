/**
 * Snapshots for `lunx test`, in Vitest's format (`__snapshots__/<file>.snap`,
 * keys `<test name> <n>`), so a project can move between the two.
 *
 *   expect(value).toMatchSnapshot()          compared with the .snap file
 *   expect(value).toMatchInlineSnapshot()    written into the test file
 *
 * New snapshots are written; changed ones fail until `lunx test -u`. With
 * `--ci`, a missing snapshot fails instead of being written.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface SnapshotOptions {
    update: boolean;
    ci: boolean;
}

interface FileState {
    file: string;
    snapFile: string;
    data: Map<string, string>;
    used: Set<string>;
    counters: Map<string, number>;
    dirty: boolean;
    inline: Array<{ line: number; column: number; text: string }>;
    stats: { added: number; updated: number; matched: number; failed: number };
}

let current: FileState | null = null;
let options: SnapshotOptions = { update: false, ci: false };

const HEADER = '// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html';

const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
const unescape = (s: string) => s.replace(/\\([\\`$])/g, '$1');

export function startFile(file: string, opts: SnapshotOptions) {
    options = opts;
    const snapFile = path.join(path.dirname(file), '__snapshots__', path.basename(file) + '.snap');
    const data = new Map<string, string>();
    try {
        const text = fs.readFileSync(snapFile, 'utf8');
        for (const m of text.matchAll(/exports\[`((?:[^`\\]|\\.)*)`\] = `((?:[^`\\]|\\.)*)`;/g)) data.set(unescape(m[1]!), unescape(m[2]!));
    } catch {
        // no snapshots yet
    }
    current = { file, snapFile, data, used: new Set(), counters: new Map(), dirty: false, inline: [], stats: { added: 0, updated: 0, matched: 0, failed: 0 } };
}

/** Writes the .snap file and inline snapshots; returns the file's counts. */
export function finishFile(allTestsRan: boolean): FileState['stats'] {
    const s = current;
    current = null;
    if (!s) return { added: 0, updated: 0, matched: 0, failed: 0 };
    // `-u` with every test run: snapshots no test asked for are dropped.
    if (options.update && allTestsRan) {
        for (const key of [...s.data.keys()]) {
            if (s.used.has(key)) continue;
            s.data.delete(key);
            s.dirty = true;
        }
    }
    if (s.dirty) {
        if (s.data.size) {
            const body = [...s.data.keys()].sort().map((k) => `exports[\`${escape(k)}\`] = \`${escape(s.data.get(k)!)}\`;\n`).join('\n');
            fs.mkdirSync(path.dirname(s.snapFile), { recursive: true });
            fs.writeFileSync(s.snapFile, `${HEADER}\n\n${body}`);
        } else fs.rmSync(s.snapFile, { force: true });
    }
    if (s.inline.length) writeInline(s.file, s.inline);
    return s.stats;
}

// ── Serialization (close to Vitest's pretty-format output) ──────────────────

export function serialize(value: unknown, indent = '', seen = new Set<unknown>()): string {
    const next = indent + '  ';
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'number' || typeof value === 'boolean') return Object.is(value, -0) ? '-0' : String(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '[Circular]';
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Date { NaN }' : value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return `[${value.name}: ${value.message}]`;
    if (typeof (value as any).outerHTML === 'string' && typeof (value as any).nodeType === 'number') return (value as any).outerHTML;
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            if (!value.length) return '[]';
            return `[\n${value.map((v) => `${next}${serialize(v, next, seen)},\n`).join('')}${indent}]`;
        }
        if (value instanceof Map) {
            if (!value.size) return 'Map {}';
            return `Map {\n${[...value].map(([k, v]) => `${next}${serialize(k, next, seen)} => ${serialize(v, next, seen)},\n`).join('')}${indent}}`;
        }
        if (value instanceof Set) {
            if (!value.size) return 'Set {}';
            return `Set {\n${[...value].map((v) => `${next}${serialize(v, next, seen)},\n`).join('')}${indent}}`;
        }
        const proto = Object.getPrototypeOf(value);
        const name = proto && proto !== Object.prototype && proto.constructor?.name ? `${proto.constructor.name} ` : '';
        const keys = Object.keys(value).sort();
        if (!keys.length) return `${name}{}`;
        return `${name}{\n${keys.map((k) => `${next}"${k}": ${serialize((value as any)[k], next, seen)},\n`).join('')}${indent}}`;
    } finally {
        seen.delete(value);
    }
}

// ── Matchers ─────────────────────────────────────────────────────────────────

interface TestState {
    testName: string;
    testFile: string;
}

type Result = { pass: boolean; message: () => string; expected?: unknown; actual?: unknown; diff?: boolean };

export function matchSnapshot(value: unknown, hint: string | undefined, test: TestState): Result {
    const s = current;
    if (!s) return { pass: false, message: () => 'toMatchSnapshot() is only available inside lunx test' };
    const base = hint ? `${test.testName}: ${hint}` : test.testName;
    const n = (s.counters.get(base) ?? 0) + 1;
    s.counters.set(base, n);
    const key = `${base} ${n}`;
    s.used.add(key);
    const received = `\n${serialize(value)}\n`;
    const stored = s.data.get(key);
    if (stored === undefined) {
        if (options.ci && !options.update) {
            s.stats.failed++;
            return { pass: false, message: () => `snapshot "${key}" is missing (--ci does not write new snapshots)` };
        }
        s.data.set(key, received);
        s.dirty = true;
        s.stats.added++;
        return { pass: true, message: () => '' };
    }
    if (stored === received) {
        s.stats.matched++;
        return { pass: true, message: () => '' };
    }
    if (options.update) {
        s.data.set(key, received);
        s.dirty = true;
        s.stats.updated++;
        return { pass: true, message: () => '' };
    }
    s.stats.failed++;
    return { pass: false, message: () => `snapshot "${key}" does not match (lunx test -u updates it)`, expected: stored.trim(), actual: received.trim(), diff: true };
}

/** Common leading indentation and the wrapping newlines removed. */
function dedent(text: string): string {
    const lines = text.replace(/^\n/, '').replace(/\n\s*$/, '').split('\n');
    const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length));
    return lines.map((l) => l.slice(Number.isFinite(pad) ? pad : 0)).join('\n');
}

export function matchInlineSnapshot(value: unknown, expected: string | undefined, test: TestState): Result {
    const s = current;
    if (!s) return { pass: false, message: () => 'toMatchInlineSnapshot() is only available inside lunx test' };
    const received = serialize(value);
    if (expected !== undefined && dedent(expected) === received) {
        s.stats.matched++;
        return { pass: true, message: () => '' };
    }
    if (expected === undefined && options.ci && !options.update) {
        s.stats.failed++;
        return { pass: false, message: () => 'inline snapshot is missing (--ci does not write new snapshots)' };
    }
    if (expected === undefined || options.update) {
        const at = callSite(test.testFile);
        if (at) {
            s.inline.push({ ...at, text: received });
            s.stats[expected === undefined ? 'added' : 'updated']++;
            return { pass: true, message: () => '' };
        }
    }
    s.stats.failed++;
    return { pass: false, message: () => 'inline snapshot does not match (lunx test -u updates it)', expected: expected === undefined ? undefined : dedent(expected), actual: received, diff: true };
}

/** Where in the test file the matcher was called (source-mapped stack frame). */
function callSite(file: string): { line: number; column: number } | null {
    const stack = new Error().stack ?? '';
    const url = file.split(path.sep).join('/');
    for (const frame of stack.split('\n')) {
        const m = /\(?((?:file:\/\/)?[^()\s]+):(\d+):(\d+)\)?$/.exec(frame.trim());
        if (!m) continue;
        const where = m[1]!.replace(/^file:\/\//, '').replace(/\?.*$/, '');
        if (where.split(path.sep).join('/').endsWith(url) || decodeURIComponent(where) === url) return { line: Number(m[2]), column: Number(m[3]) };
    }
    return null;
}

/** Puts each inline snapshot into its `toMatchInlineSnapshot(…)` call. */
function writeInline(file: string, edits: FileState['inline']) {
    let code = fs.readFileSync(file, 'utf8');
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
    const resolved = edits
        .map((e) => {
            const from = (lineStarts[e.line - 1] ?? 0) + Math.max(0, e.column - 1);
            const call = code.indexOf('toMatchInlineSnapshot(', from);
            if (call === -1) return null;
            const open = call + 'toMatchInlineSnapshot('.length;
            // The existing argument (a template literal or nothing) up to the closing paren.
            let close = open;
            if (code[open] === '`') {
                close = open + 1;
                while (close < code.length && code[close] !== '`') close += code[close] === '\\' ? 2 : 1;
                close++;
            }
            if (code.slice(close).trimStart()[0] !== ')') return null;
            const lineStart = code.lastIndexOf('\n', call) + 1;
            const pad = /^\s*/.exec(code.slice(lineStart, call))![0];
            const body = e.text.split('\n').map((l) => (l ? `${pad}  ${l}` : l)).join('\n');
            return { start: open, end: close, text: `\`\n${escape(body)}\n${pad}\`` };
        })
        .filter(Boolean)
        .sort((a, b) => b!.start - a!.start);
    for (const e of resolved) code = code.slice(0, e!.start) + e!.text + code.slice(e!.end);
    fs.writeFileSync(file, code);
}
