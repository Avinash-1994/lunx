/**
 * `lunx test --coverage`: line coverage from V8 (no instrumentation), as
 * Vitest's `coverage.provider: 'v8'`. Each test worker records precise
 * coverage through the inspector; TypeScript files are mapped back to their
 * source through the inline source maps lunx compiles them with.
 *
 * Reports: a table on the terminal, `coverage/lcov.info`, and
 * `coverage/coverage-summary.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScriptCoverage {
    url: string;
    functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>;
}

/** line (1-based) → hit count, per source file. */
export type LineHits = Map<string, Map<number, number>>;

let session: any = null;

export async function startCoverage(): Promise<void> {
    const inspector = await import('node:inspector');
    session = new inspector.Session();
    session.connect();
    const post = (method: string, params?: object) => new Promise((resolve, reject) => session.post(method, params, (err: unknown, res: unknown) => (err ? reject(err) : resolve(res))));
    await post('Profiler.enable');
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
}

export async function takeCoverage(root: string, include: (file: string) => boolean): Promise<Array<[string, Array<[number, number]>]>> {
    if (!session) return [];
    const result: any = await new Promise((resolve, reject) => session.post('Profiler.takePreciseCoverage', (err: unknown, res: unknown) => (err ? reject(err) : resolve(res))));
    session.disconnect();
    session = null;
    const hits: LineHits = new Map();
    for (const script of result.result as ScriptCoverage[]) {
        if (!script.url.startsWith('file://')) continue;
        let file: string;
        try {
            file = fileURLToPath(script.url.replace(/\?.*$/, ''));
        } catch {
            continue;
        }
        if (!file.startsWith(root + path.sep) || file.includes(`${path.sep}node_modules${path.sep}`) || !include(file)) continue;
        addScript(file, script, hits);
    }
    await settle();
    return [...hits].map(([file, lines]) => [file, [...lines]]);
}

// ── V8 ranges → source lines ─────────────────────────────────────────────────

/** Count at each offset: the innermost range covering it (V8 lists them outermost first). */
function offsetCounts(length: number, script: ScriptCoverage): Uint32Array {
    const counts = new Uint32Array(length);
    const ranges = script.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    for (const r of ranges) counts.fill(r.count, Math.max(0, r.startOffset), Math.min(length, r.endOffset));
    return counts;
}

const VLQ = new Map([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]));

/** Source map mappings → per generated line, [generatedColumn, sourceIndex, sourceLine]. */
function decode(mappings: string): Array<Array<[number, number, number]>> {
    const lines: Array<Array<[number, number, number]>> = [];
    let src = 0;
    let srcLine = 0;
    let srcCol = 0;
    for (const line of mappings.split(';')) {
        const segs: Array<[number, number, number]> = [];
        let col = 0;
        for (const seg of line.split(',')) {
            if (!seg) continue;
            const vals: number[] = [];
            let value = 0;
            let shift = 0;
            for (const ch of seg) {
                const digit = VLQ.get(ch)!;
                value += (digit & 31) << shift;
                if (digit & 32) shift += 5;
                else {
                    vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
                    value = 0;
                    shift = 0;
                }
            }
            col += vals[0]!;
            if (vals.length >= 4) {
                src += vals[1]!;
                srcLine += vals[2]!;
                srcCol += vals[3]!;
                segs.push([col, src, srcLine]);
            }
        }
        lines.push(segs);
    }
    return lines;
}

/** The code V8 ran for `file`: the source, or what lunx compiled it to (TypeScript). */
async function generatedCode(file: string): Promise<string | null> {
    const source = fs.readFileSync(file, 'utf8');
    if (!/\.[mc]?tsx?$/.test(file)) return source;
    const { compile } = await import('../engines/index.js');
    const isTsx = file.endsWith('.tsx');
    return compile(file, source, { lang: isTsx ? 'tsx' : 'ts', jsx: isTsx ? { runtime: 'automatic' } : undefined, legacyDecorators: true, sourcemap: 'inline' }).code;
}

const generated = new Map<string, Promise<string | null>>();

function addScript(file: string, script: ScriptCoverage, hits: LineHits) {
    // Synchronous path for plain JS; TypeScript is compiled again (deterministic) to map it.
    const pending = generated.get(file) ?? generatedCode(file).catch(() => null);
    generated.set(file, pending);
    queued.push(pending.then((code) => code && mapScript(file, code, script, hits)));
}
const queued: Promise<unknown>[] = [];

export async function settle(): Promise<void> {
    await Promise.all(queued.splice(0));
}

function mapScript(file: string, code: string, script: ScriptCoverage, hits: LineHits) {
    const counts = offsetCounts(code.length, script);
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const map = /\/\/# sourceMappingURL=data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)\s*$/.exec(code);
    const out = hits.get(file) ?? new Map<number, number>();
    hits.set(file, out);
    const record = (line: number, count: number) => out.set(line, Math.max(out.get(line) ?? 0, count));
    if (!map) {
        // Plain JavaScript: each non-blank line's first non-space character.
        for (let l = 0; l < lineStarts.length; l++) {
            const start = lineStarts[l]!;
            const end = lineStarts[l + 1] ?? code.length;
            const text = code.slice(start, end);
            const first = text.search(/\S/);
            if (first === -1 || /^\s*(\/\/|\*|\/\*|\}|\)|\]|import\s|export\s+(type|interface)\b)/.test(text)) continue;
            record(l + 1, counts[start + first]!);
        }
        return;
    }
    const sm = JSON.parse(Buffer.from(map[1]!, 'base64').toString('utf8'));
    const lines = decode(sm.mappings);
    for (let gl = 0; gl < lines.length; gl++) {
        for (const [col, , srcLine] of lines[gl]!) {
            const offset = (lineStarts[gl] ?? 0) + col;
            if (offset >= code.length) continue;
            record(srcLine + 1, counts[offset]!);
        }
    }
}

// ── Reports ──────────────────────────────────────────────────────────────────

export function mergeHits(all: Array<Array<[string, Array<[number, number]>]>>): LineHits {
    const merged: LineHits = new Map();
    for (const part of all) {
        for (const [file, lines] of part) {
            const m = merged.get(file) ?? new Map<number, number>();
            for (const [line, count] of lines) m.set(line, (m.get(line) ?? 0) + count);
            merged.set(file, m);
        }
    }
    return merged;
}

const ranges = (lines: number[]) => {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        let j = i;
        while (j + 1 < lines.length && lines[j + 1] === lines[j]! + 1) j++;
        out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
        i = j;
    }
    return out.join(',');
};

export function writeReports(root: string, hits: LineHits, dir = 'coverage'): { lines: number; covered: number } {
    const rows = [...hits].map(([file, lines]) => {
        const all = [...lines.keys()].sort((a, b) => a - b);
        const missed = all.filter((l) => !lines.get(l));
        return { file: path.relative(root, file).split(path.sep).join('/'), lines, total: all.length, covered: all.length - missed.length, missed };
    }).sort((a, b) => a.file.localeCompare(b.file));
    const total = rows.reduce((n, r) => n + r.total, 0);
    const covered = rows.reduce((n, r) => n + r.covered, 0);
    const pct = (c: number, t: number) => (t ? ((c / t) * 100).toFixed(1) : '100.0');
    const width = Math.max(10, ...rows.map((r) => r.file.length));
    console.log(`\n  ${'File'.padEnd(width)}  % Lines  Uncovered lines`);
    for (const r of rows) console.log(`  ${r.file.padEnd(width)}  ${pct(r.covered, r.total).padStart(7)}  ${ranges(r.missed)}`);
    console.log(`  ${'All files'.padEnd(width)}  ${pct(covered, total).padStart(7)}\n`);
    const out = path.join(root, dir);
    fs.mkdirSync(out, { recursive: true });
    const lcov = rows.map((r) => `SF:${path.join(root, r.file)}\n${[...r.lines].sort((a, b) => a[0] - b[0]).map(([l, c]) => `DA:${l},${c}`).join('\n')}\nLF:${r.total}\nLH:${r.covered}\nend_of_record\n`).join('');
    fs.writeFileSync(path.join(out, 'lcov.info'), lcov);
    const summary: Record<string, unknown> = { total: { lines: { total, covered, pct: Number(pct(covered, total)) } } };
    for (const r of rows) summary[r.file] = { lines: { total: r.total, covered: r.covered, pct: Number(pct(r.covered, r.total)) } };
    fs.writeFileSync(path.join(out, 'coverage-summary.json'), JSON.stringify(summary, null, 2));
    return { lines: total, covered };
}
