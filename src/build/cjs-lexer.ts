/**
 * The exports-module conversion of cjs-to-esm.ts without a JS syntax tree, for
 * large modules: building react-dom's AST in JS costs ~60 ms, plus ~100 ms of
 * heap growth the first time, on every cold build's critical path. A lexer
 * (strings, template literals, comments and regular expressions skipped) finds
 * the same `exports.name` accesses and top-level requires in a few ms. Tokens
 * live in typed arrays: one object per token cost more in GC than the parse.
 *
 * It is conservative: whatever it cannot classify for certain (a `this` that
 * may be top-level, a `/` it cannot place, an escaped identifier…) returns
 * undefined, and the caller falls back to the syntax tree. It returns null
 * where the syntax-tree version would too (not a static exports module).
 * Checked against the syntax tree on every CommonJS file in node_modules:
 * where the lexer decides, the output is the same.
 */

export interface LexedModule {
    /** Top-level `var x = require('…')` declarations: [start, end) and their bindings. */
    requires: Array<{ start: number; end: number; bindings: Array<{ name: string; spec: string }> }>;
    /** Each `exports.name` access: [start, end). */
    exportRefs: Array<{ start: number; end: number; name: string }>;
}

const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const CONDITION_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const DECLARATION_KEYWORDS = new Set(['var', 'let', 'const']);

// Token kinds
const ID = 1;
const NUM = 2;
const STR = 3;
const TPL = 4; // a template ending with its backtick
const TPL_OPEN = 5; // a template part ending with `${`
const REGEX = 6;
const PUNCT = 7;
// Punctuator codes beyond single characters (which use their char code)
const ARROW = 300;
const OPTIONAL = 301;
const INC = 302;
const OTHER2 = 303; // other two-character operators
// Flags
const CLOSES_HEAD = 1; // `)` of an if / while / for / with head
const CLOSES_BLOCK = 2; // `}` of a block (not an object literal)
const TERNARY = 4; // `:` of a conditional expression
const OPERAND_END = 8; // postfix `++` / `--`

// Brace frames
const FN = 1;
const BLOCK = 2;
const OBJECT = 3;
const CLASS = 4;
const TEMPLATE = 5;

const isIdStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95;
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
// ASCII classes: one table load per character in the hot loop.
const C_OTHER = 0;
const C_SPACE = 1;
const C_ID = 2;
const CHAR_CLASS = new Uint8Array(128);
for (let c = 0; c < 128; c++) CHAR_CLASS[c] = c === 32 || c === 10 || c === 13 || c === 9 || c === 11 || c === 12 ? C_SPACE : isIdStart(c) ? C_ID : C_OTHER;
const ID_PART = new Uint8Array(128);
for (let c = 0; c < 128; c++) ID_PART[c] = isIdPart(c) ? 1 : 0;
/** The words the passes need, by length and first character code. */
const MARKED: Array<Record<number, string[]>> = [];
for (const w of ['this', 'exports', 'module', 'require', '__esModule', 'var', 'let', 'const', 'function', 'class']) ((MARKED[w.length] ??= {})[w.charCodeAt(0)] ??= []).push(w);
for (let len = 0; len <= 10; len++) MARKED[len] ??= {};

/** Whether `c` `d` is a two-character operator (other than `=>`, `?.`, `++`, `--`). */
const isTwoChar = (c: number, d: number) =>
    (d === 61 && (c === 61 || c === 33 || c === 60 || c === 62 || c === 43 || c === 45 || c === 42 || c === 47 || c === 37 || c === 38 || c === 124 || c === 94)) ||
    (c === d && (c === 38 || c === 124 || c === 63 || c === 42 || c === 60 || c === 62));

interface Tokens {
    count: number;
    kind: Uint8Array;
    start: Int32Array;
    end: Int32Array;
    punct: Uint16Array;
    flags: Uint8Array;
    fnDepth: Int32Array;
    /** Indexes of the identifiers the passes look at: this, exports, module, require, __esModule, var, let, const, function, class. */
    marks: number[];
}

/**
 * Tokens of `code`, or undefined when the lexer cannot be sure of them
 * (non-ASCII or escaped identifiers, an unterminated literal).
 */
/** Whether a `/` after the last token starts a regular expression (else it divides). */
function regexAllowedAfter(code: string, kind: Uint8Array, start: Int32Array, end: Int32Array, punct: Uint16Array, flags: Uint8Array, count: number): boolean {
    if (count === 0) return true;
    const t = count - 1;
    const k = kind[t];
    if (k === TPL_OPEN) return true;
    if (k === NUM || k === STR || k === TPL || k === REGEX) return false;
    if (k === ID) return KEYWORDS_BEFORE_EXPRESSION.has(code.slice(start[t]!, end[t]!));
    if (flags[t]! & OPERAND_END) return false;
    const p = punct[t];
    if (p === 93) return false; // ]
    if (p === 41) return (flags[t]! & CLOSES_HEAD) !== 0; // )
    if (p === 125) return (flags[t]! & CLOSES_BLOCK) !== 0; // }
    return true;
}

/** Skips a template literal from just after its backtick (or the `}` resuming it): its end, negative when `${` opens an expression, 0 when unterminated. */
function skipTemplate(code: string, from: number, frames: number[], ternaries: number[]): number {
    const n = code.length;
    let j = from;
    while (j < n) {
        const c = code.charCodeAt(j);
        if (c === 92) j += 2;
        else if (c === 96) return j + 1;
        else if (c === 36 && code.charCodeAt(j + 1) === 123) {
            frames.push(TEMPLATE);
            ternaries.push(0);
            return -(j + 2);
        } else j++;
    }
    return 0;
}

function tokenize(code: string): Tokens | undefined {
    const n = code.length;
    // Every token takes at least one character: no growing.
    const cap = n + 1;
    const kind = new Uint8Array(cap);
    const start = new Int32Array(cap);
    const end = new Int32Array(cap);
    const punct = new Uint16Array(cap);
    const flags = new Uint8Array(cap);
    const depthAt = new Int32Array(cap);
    let count = 0;
    let fnDepth = 0;
    const marks: number[] = [];
    const frames: number[] = [];
    // Per `(`: whether it follows if / while / for / with (then `)` ends a statement head).
    const parens: boolean[] = [];
    // Open `?` of conditional expressions per nesting level: a `:` closes one, or is a label's,
    // a `case`'s or an object key's.
    const ternaries: number[] = [0];
    // `function` seen, waiting for its body's `{`; a class body likewise.
    let pendingFn = 0;
    let pendingClass = false;
    const word = (t: number) => code.slice(start[t]!, end[t]!);
    let i = 0;
    while (i < n) {
        const c = code.charCodeAt(i);
        const cls = c < 128 ? CHAR_CLASS[c]! : c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029 ? C_SPACE : C_OTHER;
        // Whitespace
        if (cls === C_SPACE) {
            i++;
            continue;
        }
        // Identifiers and keywords
        if (cls === C_ID) {
            let j = i + 1;
            let d = code.charCodeAt(j);
            while (d < 128 && ID_PART[d] === 1) d = code.charCodeAt(++j);
            if (d === 92 || (d > 127 && j < n)) return undefined;
            kind[count] = ID;
            start[count] = i;
            end[count] = j;
            punct[count] = 0;
            depthAt[count] = fnDepth;
            const len = j - i;
            if (len >= 3 && len <= 10 && len !== 9) {
                const words = MARKED[len]![c];
                if (words !== undefined) {
                    for (const word of words) {
                        if (!code.startsWith(word, i)) continue;
                        marks.push(count);
                        if (len === 8) pendingFn++;
                        else if (word === 'class') pendingClass = true;
                        break;
                    }
                }
            }
            count++;
            i = j;
            continue;
        }
        if (c === 47) {
            const d = code.charCodeAt(i + 1);
            // Comments
            if (d === 47) {
                while (i < n && code.charCodeAt(i) !== 10 && code.charCodeAt(i) !== 13) i++;
                continue;
            }
            if (d === 42) {
                const close = code.indexOf('*/', i + 2);
                if (close === -1) return undefined;
                i = close + 2;
                continue;
            }
            // Regular expressions
            if (regexAllowedAfter(code, kind, start, end, punct, flags, count)) {
                let j = i + 1;
                let inClass = false;
                while (j < n) {
                    const e = code.charCodeAt(j);
                    if (e === 92) j += 2;
                    else if (e === 10 || e === 13) return undefined;
                    else if (inClass) {
                        if (e === 93) inClass = false;
                        j++;
                    } else if (e === 91) {
                        inClass = true;
                        j++;
                    } else if (e === 47) break;
                    else j++;
                }
                if (j >= n) return undefined;
                j++;
                while (j < n && isIdPart(code.charCodeAt(j))) j++;
                kind[count] = REGEX;
                start[count] = i;
                end[count] = j;
                punct[count] = 0;
                depthAt[count] = fnDepth;
                count++;
                i = j;
                continue;
            }
        }
        // Strings
        if (c === 34 || c === 39) {
            let j = i + 1;
            while (j < n) {
                const d = code.charCodeAt(j);
                if (d === 92) j += 2;
                else if (d === c) break;
                else if (d === 10 || d === 13) return undefined;
                else j++;
            }
            if (j >= n) return undefined;
            kind[count] = STR;
            start[count] = i;
            end[count] = j + 1;
            punct[count] = 0;
            depthAt[count] = fnDepth;
            count++;
            i = j + 1;
            continue;
        }
        // Template literals
        if (c === 96) {
            const close = skipTemplate(code, i + 1, frames, ternaries);
            if (close === 0) return undefined;
            kind[count] = close < 0 ? TPL_OPEN : TPL;
            start[count] = i;
            end[count] = Math.abs(close);
            punct[count] = 0;
            depthAt[count] = fnDepth;
            count++;
            i = Math.abs(close);
            continue;
        }
        if (c === 92 || c > 127) return undefined;
        // Numbers
        if ((c >= 48 && c <= 57) || (c === 46 && code.charCodeAt(i + 1) >= 48 && code.charCodeAt(i + 1) <= 57)) {
            const hex = c === 48 && (code.charCodeAt(i + 1) | 32) === 120;
            let j = i + 1;
            while (j < n) {
                const d = code.charCodeAt(j);
                if (isIdPart(d) || d === 46) j++;
                else if ((d === 43 || d === 45) && !hex && (code.charCodeAt(j - 1) | 32) === 101) j++;
                else break;
            }
            kind[count] = NUM;
            start[count] = i;
            end[count] = j;
            punct[count] = 0;
            depthAt[count] = fnDepth;
            count++;
            i = j;
            continue;
        }
        // Punctuators
        const prevKind = count ? kind[count - 1] : 0;
        const prevPunct = count ? punct[count - 1] : 0;
        if (c === 40) {
            let head = false;
            if (prevKind === ID) {
                const len = end[count - 1]! - start[count - 1]!;
                const f = code.charCodeAt(start[count - 1]!);
                head = len >= 2 && len <= 5 && (f === 105 || f === 102 || f === 119) && CONDITION_KEYWORDS.has(code.slice(start[count - 1]!, end[count - 1]!));
            }
            ternaries.push(0);
            parens.push(head);
            kind[count] = PUNCT;
            start[count] = i;
            end[count] = i + 1;
            punct[count] = 40;
            depthAt[count] = fnDepth;
            count++;
            i++;
            continue;
        }
        if (c === 41) {
            ternaries.pop();
            const head = parens.pop() ?? false;
            kind[count] = PUNCT;
            start[count] = i;
            end[count] = i + 1;
            punct[count] = 41;
            depthAt[count] = fnDepth;
            count++;
            if (head) flags[count - 1] |= CLOSES_HEAD;
            i++;
            continue;
        }
        if (c === 123) {
            let frame: number;
            if (pendingFn && prevPunct === 41) {
                frame = FN;
                pendingFn--;
            } else if (pendingClass) {
                frame = CLASS;
                pendingClass = false;
            } else if (count === 0 || prevPunct === 59 || prevPunct === 123 || prevPunct === 125 || prevPunct === 41 || prevPunct === ARROW) {
                frame = BLOCK;
            } else if (prevKind === ID && end[count - 1]! - start[count - 1]! <= 7 && /^(else|try|finally|do)$/.test(code.slice(start[count - 1]!, end[count - 1]!))) {
                frame = BLOCK;
            } else if (prevPunct === 58) {
                // After a conditional's `:` or an object key, an object literal; after a label or
                // a `case` in a block, a block.
                frame = flags[count - 1]! & TERNARY || frames[frames.length - 1] === OBJECT ? OBJECT : BLOCK;
            } else frame = OBJECT;
            frames.push(frame);
            ternaries.push(0);
            if (frame === FN) fnDepth++;
            kind[count] = PUNCT;
            start[count] = i;
            end[count] = i + 1;
            punct[count] = 123;
            depthAt[count] = fnDepth;
            count++;
            i++;
            continue;
        }
        if (c === 125) {
            const frame = frames.pop();
            if (frame === undefined) return undefined;
            ternaries.pop();
            if (frame === TEMPLATE) {
                // The template resumes after `}`.
                const close = skipTemplate(code, i + 1, frames, ternaries);
                if (close === 0) return undefined;
                kind[count] = close < 0 ? TPL_OPEN : TPL;
                start[count] = i;
                end[count] = Math.abs(close);
                punct[count] = 0;
                depthAt[count] = fnDepth;
                count++;
                i = Math.abs(close);
                continue;
            }
            if (frame === FN) fnDepth--;
            kind[count] = PUNCT;
            start[count] = i;
            end[count] = i + 1;
            punct[count] = 125;
            depthAt[count] = fnDepth;
            count++;
            if (frame !== OBJECT) flags[count - 1] |= CLOSES_BLOCK;
            i++;
            continue;
        }
        const c2 = code.charCodeAt(i + 1);
        if (c === 61 && c2 === 62) {
            kind[count] = PUNCT;
            start[count] = i;
            end[count] = i + 2;
            punct[count] = ARROW;
            depthAt[count] = fnDepth;
            count++;
            i += 2;
            continue;
        }
        if (c === 63 && c2 === 46 && !(code.charCodeAt(i + 2) >= 48 && code.charCodeAt(i + 2) <= 57)) {
            kind[count] = PUNCT;
            start[count] = i;
            end[count] = i + 2;
            punct[count] = OPTIONAL;
            depthAt[count] = fnDepth;
            count++;
            i += 2;
            continue;
        }
        if ((c === 43 || c === 45) && c2 === c) {
            // A postfix `++` / `--` ends an operand: `a++ / 2` divides.
            const postfix = prevKind !== 0 && prevKind !== PUNCT ? true : prevPunct === 41 || prevPunct === 93;
            kind[count] = PUNCT;
            start[count] = i;
            end[count] = i + 2;
            punct[count] = INC;
            depthAt[count] = fnDepth;
            count++;
            if (postfix) flags[count - 1] |= OPERAND_END;
            i += 2;
            continue;
        }
        if (isTwoChar(c, c2)) {
            kind[count] = PUNCT;
            start[count] = i;
            end[count] = i + 2;
            punct[count] = OTHER2;
            depthAt[count] = fnDepth;
            count++;
            i += 2;
            continue;
        }
        if (c === 91) ternaries.push(0);
        else if (c === 93) ternaries.pop();
        else if (c === 63) ternaries[ternaries.length - 1]!++;
        kind[count] = PUNCT;
        start[count] = i;
        end[count] = i + 1;
        punct[count] = c;
        depthAt[count] = fnDepth;
        count++;
        if (c === 58 && ternaries[ternaries.length - 1]! > 0) {
            ternaries[ternaries.length - 1]!--;
            flags[count - 1] |= TERNARY;
        }
        i++;
    }
    if (frames.length || parens.length || pendingClass) return undefined;
    return { count, kind, start, end, punct, flags, fnDepth: depthAt, marks };
}

/** Whether a name in `names` is declared (var / let / const lists, function, class) from token `from` on. */
function redeclares(code: string, tk: Tokens, from: number, names: Set<string>): boolean {
    const { count, kind, start, end, punct, marks } = tk;
    const word = (t: number) => code.slice(start[t]!, end[t]!);
    const isOpen = (t: number) => (kind[t] === PUNCT && (punct[t] === 40 || punct[t] === 91 || punct[t] === 123)) || kind[t] === TPL_OPEN;
    const isClose = (t: number) => (kind[t] === PUNCT && (punct[t] === 41 || punct[t] === 93 || punct[t] === 125)) || ((kind[t] === TPL || kind[t] === TPL_OPEN) && code.charCodeAt(start[t]!) === 125);
    for (const t of marks) {
        if (t < from) continue;
        const len = end[t]! - start[t]!;
        if (len !== 3 && len !== 5 && len !== 8) continue;
        const w = word(t);
        if ((w === 'function' || w === 'class') && kind[t + 1] === ID && names.has(word(t + 1))) return true;
        if (!DECLARATION_KEYWORDS.has(w) || (t > 0 && punct[t - 1] === 46)) continue;
        // The list's bindings: a name right after the keyword or a `,` at its own nesting level,
        // up to the `;` (or the `in` / `of` of a for head) that ends it. Patterns: any name inside.
        let depth = 0;
        let expectBinding = true;
        for (let j = t + 1; j < count; j++) {
            if (depth === 0 && ((kind[j] === PUNCT && punct[j] === 59) || (kind[j] === ID && (word(j) === 'in' || word(j) === 'of')))) break;
            if (isOpen(j)) {
                if (expectBinding && depth === 0 && kind[j] === PUNCT && (punct[j] === 91 || punct[j] === 123)) {
                    // A destructuring pattern: every name in it counts.
                    let d = 0;
                    for (let q = j; q < count; q++) {
                        if (isOpen(q)) d++;
                        else if (isClose(q)) d--;
                        if (kind[q] === ID && names.has(word(q))) return true;
                        if (d === 0) break;
                    }
                }
                depth++;
                expectBinding = false;
                continue;
            }
            if (isClose(j)) {
                if (depth === 0) break;
                depth--;
                continue;
            }
            if (depth === 0 && kind[j] === PUNCT && punct[j] === 44) {
                expectBinding = true;
                continue;
            }
            if (expectBinding && depth === 0 && kind[j] === ID) {
                if (names.has(word(j))) return true;
                expectBinding = false;
                continue;
            }
            // A statement keyword at the list's level ends it (no `;`, a line break).
            if (depth === 0 && kind[j] === ID && !expectBinding && kind[j - 1] !== PUNCT) break;
            expectBinding = false;
        }
    }
    return false;
}

/**
 * The exports-module shape found by tokens: undefined when unsure (use the syntax tree),
 * null when it is not one.
 */
export function lexExportsModule(code: string): LexedModule | null | undefined {
    const tk = tokenize(code);
    if (!tk) return undefined;
    const { count, kind, start, end, punct, fnDepth, marks } = tk;
    const word = (t: number) => code.slice(start[t]!, end[t]!);
    const is = (t: number, w: string) => t < count && kind[t] === ID && end[t]! - start[t]! === w.length && code.startsWith(w, start[t]!);
    const isPunct = (t: number, p: number) => t < count && kind[t] === PUNCT && punct[t] === p;
    const requires: LexedModule['requires'] = [];
    const exportRefs: LexedModule['exportRefs'] = [];
    let k = 0;
    // 'use strict' directive
    if (count && kind[0] === STR && code.slice(start[0]! + 1, end[0]! - 1) === 'use strict') {
        k = 1;
        if (isPunct(k, 59)) k++;
    }
    // Leading `var a = require('x'), b = require('y');` statements.
    const allowed = new Set<number>(); // token indexes of the requires' `require`
    while (k < count && kind[k] === ID && DECLARATION_KEYWORDS.has(word(k))) {
        const from = start[k]!;
        let j = k + 1;
        const bindings: Array<{ name: string; spec: string }> = [];
        for (;;) {
            if (!(kind[j] === ID && isPunct(j + 1, 61) && is(j + 2, 'require') && isPunct(j + 3, 40) && kind[j + 4] === STR && isPunct(j + 5, 41))) {
                // A declaration that is not (only) requires: past the requires.
                if (bindings.length) return null;
                break;
            }
            const spec = code.slice(start[j + 4]! + 1, end[j + 4]! - 1);
            if (spec.includes('\\')) return undefined;
            bindings.push({ name: word(j), spec });
            allowed.add(j + 2);
            j += 6;
            if (isPunct(j, 44)) {
                j++;
                continue;
            }
            break;
        }
        if (!bindings.length) break;
        if (isPunct(j, 59)) j++;
        else if (j < count && code.slice(end[j - 1]!, start[j]!).indexOf('\n') === -1) return null;
        requires.push({ start: from, end: end[j - 1]!, bindings });
        k = j;
    }
    const namespaces = new Set(requires.flatMap((r) => r.bindings.map((b) => b.name)));
    // A namespace declared again (`var a, React;`, `function React`) would clash with its
    // import: the syntax tree tells a top-level declaration from a nested one.
    if (namespaces.size && redeclares(code, tk, k, namespaces)) return undefined;
    for (let m = 0; m < marks.length; m++) {
        const t = marks[m]!;
        const len = end[t]! - start[t]!;
        if (len !== 4 && len !== 6 && len !== 7 && len !== 10) continue;
        const isProperty = t > 0 && kind[t - 1] === PUNCT && (punct[t - 1] === 46 || punct[t - 1] === OPTIONAL);
        if (len === 4) {
            if (is(t, 'this') && !isProperty && fnDepth[t] === 0) return undefined;
            continue;
        }
        const exports = is(t, 'exports');
        if (!exports && !is(t, 'module') && !is(t, 'require') && !is(t, '__esModule')) continue;
        if (isProperty) continue;
        // An object key (`{ exports: … }`): not a reference. A shorthand `{ exports }` is one.
        // (`a ? exports : b` also has `:` after, but a ternary branch never follows `{` or `,`.)
        if (isPunct(t + 1, 58) && t > 0 && (isPunct(t - 1, 123) || isPunct(t - 1, 44))) continue;
        if (allowed.has(t)) continue;
        if (exports && isPunct(t + 1, 46)) {
            if (kind[t + 2] !== ID) return undefined;
            const name = word(t + 2);
            if (name === '__esModule' || name === 'default') return null;
            exportRefs.push({ start: start[t]!, end: end[t + 2]!, name });
            continue;
        }
        // `module`, `require`, `exports` used any other way: not a static module.
        return null;
    }
    return { requires, exportRefs };
}
