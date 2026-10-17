//! The CommonJS exports-module lexer of src/build/cjs-lexer.ts, in Rust: the
//! same tokens and the same decisions, on the same UTF-16 code units (offsets
//! are JavaScript string indexes). A production build of a React app runs it
//! once, on react-dom (~600 KB): ~70 ms in cold JavaScript, a few ms here.
//!
//! Status: 0 = unsure (the caller falls back to the syntax tree), 1 = not a
//! static exports module, 2 = one (requires and export references found).

use napi::bindgen_prelude::Utf16String;
use napi_derive::napi;
use std::collections::HashSet;

#[napi(object)]
pub struct CjsLexBinding {
    pub name: String,
    pub spec: String,
}

#[napi(object)]
pub struct CjsLexRequire {
    pub start: u32,
    pub end: u32,
    pub bindings: Vec<CjsLexBinding>,
}

#[napi(object)]
pub struct CjsLexExportRef {
    pub start: u32,
    pub end: u32,
    pub name: String,
}

#[napi(object)]
pub struct CjsLexResult {
    pub status: u32,
    pub requires: Vec<CjsLexRequire>,
    pub export_refs: Vec<CjsLexExportRef>,
}

/// `lexExportsModule` of src/build/cjs-lexer.ts.
#[napi]
pub fn lex_cjs_exports(code: Utf16String) -> CjsLexResult {
    match lex(&code) {
        Lexed::Unsure => result(0, Vec::new(), Vec::new()),
        Lexed::NotModule => result(1, Vec::new(), Vec::new()),
        Lexed::Module(requires, export_refs) => result(2, requires, export_refs),
    }
}

fn result(status: u32, requires: Vec<CjsLexRequire>, export_refs: Vec<CjsLexExportRef>) -> CjsLexResult {
    CjsLexResult { status, requires, export_refs }
}

pub enum Lexed {
    Unsure,
    NotModule,
    Module(Vec<CjsLexRequire>, Vec<CjsLexExportRef>),
}

// Token kinds
const ID: u8 = 1;
const NUM: u8 = 2;
const STR: u8 = 3;
const TPL: u8 = 4; // a template ending with its backtick
const TPL_OPEN: u8 = 5; // a template part ending with `${`
const REGEX: u8 = 6;
const PUNCT: u8 = 7;
// Punctuator codes beyond single characters (which use their char code)
const ARROW: u16 = 300;
const OPTIONAL: u16 = 301;
const INC: u16 = 302;
const OTHER2: u16 = 303;
// Flags
const CLOSES_HEAD: u8 = 1;
const CLOSES_BLOCK: u8 = 2;
const TERNARY: u8 = 4;
const OPERAND_END: u8 = 8;
// Brace frames
const FN: u8 = 1;
const BLOCK: u8 = 2;
const OBJECT: u8 = 3;
const CLASS: u8 = 4;
const TEMPLATE: u8 = 5;

/// Past the end, as `charCodeAt` returns NaN: matches no character test.
const NONE: u32 = u32::MAX;

const KEYWORDS_BEFORE_EXPRESSION: &[&str] = &["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"];
const CONDITION_KEYWORDS: &[&str] = &["if", "while", "for", "with"];
const DECLARATION_KEYWORDS: &[&str] = &["var", "let", "const"];
const MARKED: &[&str] = &["this", "exports", "module", "require", "__esModule", "var", "let", "const", "function", "class"];

fn is_id_start(c: u32) -> bool {
    (97..=122).contains(&c) || (65..=90).contains(&c) || c == 36 || c == 95
}
fn is_id_part(c: u32) -> bool {
    is_id_start(c) || (48..=57).contains(&c)
}
fn is_space(c: u32) -> bool {
    c == 32 || c == 10 || c == 13 || c == 9 || c == 11 || c == 12 || c == 0xa0 || c == 0xfeff || c == 0x2028 || c == 0x2029
}
fn is_two_char(c: u32, d: u32) -> bool {
    (d == 61 && matches!(c, 61 | 33 | 60 | 62 | 43 | 45 | 42 | 47 | 37 | 38 | 124 | 94)) || (c == d && matches!(c, 38 | 124 | 63 | 42 | 60 | 62))
}

fn eq(code: &[u16], from: usize, to: usize, word: &str) -> bool {
    to - from == word.len() && code[from..to].iter().zip(word.bytes()).all(|(&a, b)| a == b as u16)
}
fn starts_with(code: &[u16], at: usize, word: &str) -> bool {
    at + word.len() <= code.len() && eq(code, at, at + word.len(), word)
}
fn index_of(code: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if from >= code.len() || needle.len() > code.len() - from {
        return None;
    }
    let first = needle[0];
    let last_start = code.len() - needle.len();
    let mut i = from;
    while i <= last_start {
        if code[i] == first && code[i..i + needle.len()] == *needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

struct Tokens {
    count: usize,
    kind: Vec<u8>,
    start: Vec<u32>,
    end: Vec<u32>,
    punct: Vec<u16>,
    flags: Vec<u8>,
    depth: Vec<i32>,
    marks: Vec<usize>,
}

impl Tokens {
    // Beyond the last token, 0 (as the JS version's zero-filled typed arrays).
    fn kind(&self, t: usize) -> u8 {
        if t < self.count { self.kind[t] } else { 0 }
    }
    fn punct(&self, t: usize) -> u16 {
        if t < self.count { self.punct[t] } else { 0 }
    }
    fn start(&self, t: usize) -> usize {
        if t < self.count { self.start[t] as usize } else { 0 }
    }
    fn end(&self, t: usize) -> usize {
        if t < self.count { self.end[t] as usize } else { 0 }
    }
    fn push(&mut self, kind: u8, start: usize, end: usize, punct: u16, depth: i32) {
        self.kind.push(kind);
        self.start.push(start as u32);
        self.end.push(end as u32);
        self.punct.push(punct);
        self.flags.push(0);
        self.depth.push(depth);
        self.count += 1;
    }
}

fn regex_allowed_after(code: &[u16], tk: &Tokens) -> bool {
    if tk.count == 0 {
        return true;
    }
    let t = tk.count - 1;
    let k = tk.kind[t];
    if k == TPL_OPEN {
        return true;
    }
    if k == NUM || k == STR || k == TPL || k == REGEX {
        return false;
    }
    if k == ID {
        let (s, e) = (tk.start[t] as usize, tk.end[t] as usize);
        return KEYWORDS_BEFORE_EXPRESSION.iter().any(|w| eq(code, s, e, w));
    }
    if tk.flags[t] & OPERAND_END != 0 {
        return false;
    }
    match tk.punct[t] {
        93 => false,
        41 => tk.flags[t] & CLOSES_HEAD != 0,
        125 => tk.flags[t] & CLOSES_BLOCK != 0,
        _ => true,
    }
}

/// Skips a template literal from just after its backtick (or the `}` resuming it):
/// its end, negative when `${` opens an expression, 0 when unterminated.
fn skip_template(code: &[u16], from: usize, frames: &mut Vec<u8>, ternaries: &mut Vec<i32>) -> i64 {
    let n = code.len();
    let mut j = from;
    while j < n {
        let c = code[j] as u32;
        if c == 92 {
            j += 2;
        } else if c == 96 {
            return (j + 1) as i64;
        } else if c == 36 && j + 1 < n && code[j + 1] == 123 {
            frames.push(TEMPLATE);
            ternaries.push(0);
            return -((j + 2) as i64);
        } else {
            j += 1;
        }
    }
    0
}

fn tokenize(code: &[u16]) -> Option<Tokens> {
    let n = code.len();
    let at = |j: usize| -> u32 { if j < n { code[j] as u32 } else { NONE } };
    let cap = n / 3 + 16;
    let mut tk = Tokens {
        count: 0,
        kind: Vec::with_capacity(cap),
        start: Vec::with_capacity(cap),
        end: Vec::with_capacity(cap),
        punct: Vec::with_capacity(cap),
        flags: Vec::with_capacity(cap),
        depth: Vec::with_capacity(cap),
        marks: Vec::new(),
    };
    let mut fn_depth: i32 = 0;
    let mut frames: Vec<u8> = Vec::new();
    let mut parens: Vec<bool> = Vec::new();
    let mut ternaries: Vec<i32> = vec![0];
    let mut pending_fn: i32 = 0;
    let mut pending_class = false;
    let comment_close: [u16; 2] = [42, 47];
    let mut i = 0;
    while i < n {
        let c = code[i] as u32;
        if is_space(c) {
            i += 1;
            continue;
        }
        // Identifiers and keywords
        if is_id_start(c) {
            let mut j = i + 1;
            let mut d = at(j);
            while d < 128 && is_id_part(d) {
                j += 1;
                d = at(j);
            }
            if d == 92 || (d > 127 && d != NONE && j < n) {
                return None;
            }
            tk.push(ID, i, j, 0, fn_depth);
            let len = j - i;
            if (3..=10).contains(&len) && len != 9 {
                for w in MARKED {
                    if w.len() == len && w.as_bytes()[0] as u32 == c && starts_with(code, i, w) {
                        tk.marks.push(tk.count - 1);
                        if len == 8 {
                            pending_fn += 1;
                        } else if *w == "class" {
                            pending_class = true;
                        }
                        break;
                    }
                }
            }
            i = j;
            continue;
        }
        if c == 47 {
            let d = at(i + 1);
            // Comments
            if d == 47 {
                while i < n && code[i] != 10 && code[i] != 13 {
                    i += 1;
                }
                continue;
            }
            if d == 42 {
                match index_of(code, &comment_close, i + 2) {
                    None => return None,
                    Some(close) => {
                        i = close + 2;
                        continue;
                    }
                }
            }
            // Regular expressions
            if regex_allowed_after(code, &tk) {
                let mut j = i + 1;
                let mut in_class = false;
                while j < n {
                    let e = code[j] as u32;
                    if e == 92 {
                        j += 2;
                    } else if e == 10 || e == 13 {
                        return None;
                    } else if in_class {
                        if e == 93 {
                            in_class = false;
                        }
                        j += 1;
                    } else if e == 91 {
                        in_class = true;
                        j += 1;
                    } else if e == 47 {
                        break;
                    } else {
                        j += 1;
                    }
                }
                if j >= n {
                    return None;
                }
                j += 1;
                while j < n && is_id_part(code[j] as u32) {
                    j += 1;
                }
                tk.push(REGEX, i, j, 0, fn_depth);
                i = j;
                continue;
            }
        }
        // Strings
        if c == 34 || c == 39 {
            let mut j = i + 1;
            while j < n {
                let d = code[j] as u32;
                if d == 92 {
                    j += 2;
                } else if d == c {
                    break;
                } else if d == 10 || d == 13 {
                    return None;
                } else {
                    j += 1;
                }
            }
            if j >= n {
                return None;
            }
            tk.push(STR, i, j + 1, 0, fn_depth);
            i = j + 1;
            continue;
        }
        // Template literals
        if c == 96 {
            let close = skip_template(code, i + 1, &mut frames, &mut ternaries);
            if close == 0 {
                return None;
            }
            let e = close.unsigned_abs() as usize;
            tk.push(if close < 0 { TPL_OPEN } else { TPL }, i, e, 0, fn_depth);
            i = e;
            continue;
        }
        if c == 92 || c > 127 {
            return None;
        }
        // Numbers
        let c1 = at(i + 1);
        if (48..=57).contains(&c) || (c == 46 && (48..=57).contains(&c1)) {
            let hex = c == 48 && c1 != NONE && (c1 | 32) == 120;
            let mut j = i + 1;
            while j < n {
                let d = code[j] as u32;
                if is_id_part(d) || d == 46 {
                    j += 1;
                } else if (d == 43 || d == 45) && !hex && (code[j - 1] as u32 | 32) == 101 {
                    j += 1;
                } else {
                    break;
                }
            }
            tk.push(NUM, i, j, 0, fn_depth);
            i = j;
            continue;
        }
        // Punctuators
        let prev_kind = if tk.count > 0 { tk.kind[tk.count - 1] } else { 0 };
        let prev_punct = if tk.count > 0 { tk.punct[tk.count - 1] } else { 0 };
        if c == 40 {
            let mut head = false;
            if prev_kind == ID {
                let (s, e) = (tk.start[tk.count - 1] as usize, tk.end[tk.count - 1] as usize);
                let len = e - s;
                let f = code[s] as u32;
                head = (2..=5).contains(&len) && (f == 105 || f == 102 || f == 119) && CONDITION_KEYWORDS.iter().any(|w| eq(code, s, e, w));
            }
            ternaries.push(0);
            parens.push(head);
            tk.push(PUNCT, i, i + 1, 40, fn_depth);
            i += 1;
            continue;
        }
        if c == 41 {
            ternaries.pop();
            let head = parens.pop().unwrap_or(false);
            tk.push(PUNCT, i, i + 1, 41, fn_depth);
            if head {
                tk.flags[tk.count - 1] |= CLOSES_HEAD;
            }
            i += 1;
            continue;
        }
        if c == 123 {
            let frame;
            if pending_fn > 0 && prev_punct == 41 {
                frame = FN;
                pending_fn -= 1;
            } else if pending_class {
                frame = CLASS;
                pending_class = false;
            } else if tk.count == 0 || prev_punct == 59 || prev_punct == 123 || prev_punct == 125 || prev_punct == 41 || prev_punct == ARROW {
                frame = BLOCK;
            } else if prev_kind == ID && {
                let (s, e) = (tk.start[tk.count - 1] as usize, tk.end[tk.count - 1] as usize);
                e - s <= 7 && ["else", "try", "finally", "do"].iter().any(|w| eq(code, s, e, w))
            } {
                frame = BLOCK;
            } else if prev_punct == 58 {
                // After a conditional's `:` or an object key, an object literal; after a label or
                // a `case` in a block, a block.
                frame = if tk.flags[tk.count - 1] & TERNARY != 0 || frames.last() == Some(&OBJECT) { OBJECT } else { BLOCK };
            } else {
                frame = OBJECT;
            }
            frames.push(frame);
            ternaries.push(0);
            if frame == FN {
                fn_depth += 1;
            }
            tk.push(PUNCT, i, i + 1, 123, fn_depth);
            i += 1;
            continue;
        }
        if c == 125 {
            let frame = match frames.pop() {
                None => return None,
                Some(f) => f,
            };
            ternaries.pop();
            if frame == TEMPLATE {
                // The template resumes after `}`.
                let close = skip_template(code, i + 1, &mut frames, &mut ternaries);
                if close == 0 {
                    return None;
                }
                let e = close.unsigned_abs() as usize;
                tk.push(if close < 0 { TPL_OPEN } else { TPL }, i, e, 0, fn_depth);
                i = e;
                continue;
            }
            if frame == FN {
                fn_depth -= 1;
            }
            tk.push(PUNCT, i, i + 1, 125, fn_depth);
            if frame != OBJECT {
                tk.flags[tk.count - 1] |= CLOSES_BLOCK;
            }
            i += 1;
            continue;
        }
        let c2 = c1;
        if c == 61 && c2 == 62 {
            tk.push(PUNCT, i, i + 2, ARROW, fn_depth);
            i += 2;
            continue;
        }
        if c == 63 && c2 == 46 && !(48..=57).contains(&at(i + 2)) {
            tk.push(PUNCT, i, i + 2, OPTIONAL, fn_depth);
            i += 2;
            continue;
        }
        if (c == 43 || c == 45) && c2 == c {
            // A postfix `++` / `--` ends an operand: `a++ / 2` divides.
            let postfix = if prev_kind != 0 && prev_kind != PUNCT { true } else { prev_punct == 41 || prev_punct == 93 };
            tk.push(PUNCT, i, i + 2, INC, fn_depth);
            if postfix {
                tk.flags[tk.count - 1] |= OPERAND_END;
            }
            i += 2;
            continue;
        }
        if is_two_char(c, c2) {
            tk.push(PUNCT, i, i + 2, OTHER2, fn_depth);
            i += 2;
            continue;
        }
        if c == 91 {
            ternaries.push(0);
        } else if c == 93 {
            ternaries.pop();
        } else if c == 63 {
            if let Some(last) = ternaries.last_mut() {
                *last += 1;
            }
        }
        tk.push(PUNCT, i, i + 1, c as u16, fn_depth);
        if c == 58 {
            if let Some(last) = ternaries.last_mut() {
                if *last > 0 {
                    *last -= 1;
                    tk.flags[tk.count - 1] |= TERNARY;
                }
            }
        }
        i += 1;
    }
    if !frames.is_empty() || !parens.is_empty() || pending_class {
        return None;
    }
    Some(tk)
}

fn word<'a>(code: &'a [u16], tk: &Tokens, t: usize) -> &'a [u16] {
    &code[tk.start(t)..tk.end(t).max(tk.start(t))]
}

fn is_word(code: &[u16], tk: &Tokens, t: usize, w: &str) -> bool {
    eq(code, tk.start(t), tk.end(t).max(tk.start(t)), w)
}

/// Whether a name in `names` is declared (var / let / const lists, function, class) from token `from` on.
fn redeclares(code: &[u16], tk: &Tokens, from: usize, names: &HashSet<Vec<u16>>) -> bool {
    let count = tk.count;
    let is_open = |t: usize| (tk.kind(t) == PUNCT && matches!(tk.punct(t), 40 | 91 | 123)) || tk.kind(t) == TPL_OPEN;
    let is_close = |t: usize| {
        (tk.kind(t) == PUNCT && matches!(tk.punct(t), 41 | 93 | 125)) || ((tk.kind(t) == TPL || tk.kind(t) == TPL_OPEN) && code[tk.start(t)] == 125)
    };
    for &t in &tk.marks {
        if t < from {
            continue;
        }
        let len = tk.end(t) - tk.start(t);
        if len != 3 && len != 5 && len != 8 {
            continue;
        }
        if (is_word(code, tk, t, "function") || is_word(code, tk, t, "class")) && tk.kind(t + 1) == ID && names.contains(word(code, tk, t + 1)) {
            return true;
        }
        if !DECLARATION_KEYWORDS.iter().any(|w| is_word(code, tk, t, w)) || (t > 0 && tk.punct(t - 1) == 46) {
            continue;
        }
        // The list's bindings: a name right after the keyword or a `,` at its own nesting level,
        // up to the `;` (or the `in` / `of` of a for head) that ends it. Patterns: any name inside.
        let mut depth = 0i32;
        let mut expect_binding = true;
        let mut j = t + 1;
        while j < count {
            if depth == 0 && ((tk.kind(j) == PUNCT && tk.punct(j) == 59) || (tk.kind(j) == ID && (is_word(code, tk, j, "in") || is_word(code, tk, j, "of")))) {
                break;
            }
            if is_open(j) {
                if expect_binding && depth == 0 && tk.kind(j) == PUNCT && (tk.punct(j) == 91 || tk.punct(j) == 123) {
                    // A destructuring pattern: every name in it counts.
                    let mut d = 0i32;
                    let mut q = j;
                    while q < count {
                        if is_open(q) {
                            d += 1;
                        } else if is_close(q) {
                            d -= 1;
                        }
                        if tk.kind(q) == ID && names.contains(word(code, tk, q)) {
                            return true;
                        }
                        if d == 0 {
                            break;
                        }
                        q += 1;
                    }
                }
                depth += 1;
                expect_binding = false;
                j += 1;
                continue;
            }
            if is_close(j) {
                if depth == 0 {
                    break;
                }
                depth -= 1;
                j += 1;
                continue;
            }
            if depth == 0 && tk.kind(j) == PUNCT && tk.punct(j) == 44 {
                expect_binding = true;
                j += 1;
                continue;
            }
            if expect_binding && depth == 0 && tk.kind(j) == ID {
                if names.contains(word(code, tk, j)) {
                    return true;
                }
                expect_binding = false;
                j += 1;
                continue;
            }
            // A statement keyword at the list's level ends it (no `;`, a line break).
            if depth == 0 && tk.kind(j) == ID && !expect_binding && tk.kind(j - 1) != PUNCT {
                break;
            }
            expect_binding = false;
            j += 1;
        }
    }
    false
}

fn utf16(code: &[u16]) -> Option<String> {
    String::from_utf16(code).ok()
}

pub fn lex(code: &[u16]) -> Lexed {
    let tk = match tokenize(code) {
        None => return Lexed::Unsure,
        Some(tk) => tk,
    };
    let count = tk.count;
    let is = |t: usize, w: &str| t < count && tk.kind[t] == ID && eq(code, tk.start[t] as usize, tk.end[t] as usize, w);
    let is_punct = |t: usize, p: u16| t < count && tk.kind[t] == PUNCT && tk.punct[t] == p;
    let mut requires: Vec<CjsLexRequire> = Vec::new();
    let mut export_refs: Vec<CjsLexExportRef> = Vec::new();
    let mut k = 0usize;
    // 'use strict' directive
    if count > 0 && tk.kind[0] == STR && {
        let (s, e) = (tk.start[0] as usize, tk.end[0] as usize);
        e >= s + 2 && eq(code, s + 1, e - 1, "use strict")
    } {
        k = 1;
        if is_punct(k, 59) {
            k += 1;
        }
    }
    // Leading `var a = require('x'), b = require('y');` statements.
    let mut allowed: HashSet<usize> = HashSet::new();
    let mut namespaces: HashSet<Vec<u16>> = HashSet::new();
    while k < count && tk.kind[k] == ID && DECLARATION_KEYWORDS.iter().any(|w| is(k, w)) {
        let from = tk.start[k];
        let mut j = k + 1;
        let mut bindings: Vec<CjsLexBinding> = Vec::new();
        loop {
            if !(tk.kind(j) == ID && is_punct(j + 1, 61) && is(j + 2, "require") && is_punct(j + 3, 40) && tk.kind(j + 4) == STR && is_punct(j + 5, 41)) {
                // A declaration that is not (only) requires: past the requires.
                if !bindings.is_empty() {
                    return Lexed::NotModule;
                }
                break;
            }
            let spec = &code[tk.start(j + 4) + 1..tk.end(j + 4) - 1];
            if spec.contains(&92) {
                return Lexed::Unsure;
            }
            let (name, spec) = match (utf16(word(code, &tk, j)), utf16(spec)) {
                (Some(name), Some(spec)) => (name, spec),
                _ => return Lexed::Unsure,
            };
            namespaces.insert(word(code, &tk, j).to_vec());
            bindings.push(CjsLexBinding { name, spec });
            allowed.insert(j + 2);
            j += 6;
            if is_punct(j, 44) {
                j += 1;
                continue;
            }
            break;
        }
        if bindings.is_empty() {
            break;
        }
        if is_punct(j, 59) {
            j += 1;
        } else if j < count && !code[tk.end(j - 1)..tk.start(j)].contains(&10) {
            return Lexed::NotModule;
        }
        requires.push(CjsLexRequire { start: from, end: tk.end[j - 1], bindings });
        k = j;
    }
    // A namespace declared again (`var a, React;`, `function React`) would clash with its
    // import: the syntax tree tells a top-level declaration from a nested one.
    if !namespaces.is_empty() && redeclares(code, &tk, k, &namespaces) {
        return Lexed::Unsure;
    }
    for &t in &tk.marks {
        let len = tk.end[t] as usize - tk.start[t] as usize;
        if len != 4 && len != 6 && len != 7 && len != 10 {
            continue;
        }
        let is_property = t > 0 && tk.kind[t - 1] == PUNCT && (tk.punct[t - 1] == 46 || tk.punct[t - 1] == OPTIONAL);
        if len == 4 {
            if is(t, "this") && !is_property && tk.depth[t] == 0 {
                return Lexed::Unsure;
            }
            continue;
        }
        let exports = is(t, "exports");
        if !exports && !is(t, "module") && !is(t, "require") && !is(t, "__esModule") {
            continue;
        }
        if is_property {
            continue;
        }
        // An object key (`{ exports: … }`): not a reference. A shorthand `{ exports }` is one.
        if is_punct(t + 1, 58) && t > 0 && (is_punct(t - 1, 123) || is_punct(t - 1, 44)) {
            continue;
        }
        if allowed.contains(&t) {
            continue;
        }
        if exports && is_punct(t + 1, 46) {
            if tk.kind(t + 2) != ID {
                return Lexed::Unsure;
            }
            let name = match utf16(word(code, &tk, t + 2)) {
                Some(name) => name,
                None => return Lexed::Unsure,
            };
            if name == "__esModule" || name == "default" {
                return Lexed::NotModule;
            }
            export_refs.push(CjsLexExportRef { start: tk.start[t], end: tk.end[t + 2], name });
            continue;
        }
        // `module`, `require`, `exports` used any other way: not a static module.
        return Lexed::NotModule;
    }
    Lexed::Module(requires, export_refs)
}
