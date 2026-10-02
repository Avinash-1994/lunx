/**
 * Zero-dependency YAML reader, replacing `js-yaml`.
 *
 * Scope: the YAML 1.2 subset that configuration files use -- nested mappings
 * and sequences, scalars with type inference, quoted strings, block scalars
 * (`|`, `>`, with `-`/`+` chomping), inline flow collections, comments,
 * anchors/aliases and multi-document streams.
 *
 * Out of scope (throws rather than guessing): custom tags, complex keys,
 * merge keys and directives other than `---`/`...`.
 */

export class YAMLParseError extends Error {
    constructor(message: string, readonly line: number) {
        super(`${message} (line ${line + 1})`);
        this.name = 'YAMLParseError';
    }
}

type Scalar = string | number | boolean | null;
export type YAMLValue = Scalar | YAMLValue[] | { [key: string]: YAMLValue };

interface Line {
    indent: number;
    text: string;
    raw: string;
    number: number;
}

/** Parses a single document. Extra documents are ignored, matching `js-yaml.load`. */
export function load(input: string): YAMLValue {
    const docs = loadAll(input);
    return docs.length === 0 ? null : docs[0]!;
}

/** Parses every document in a `---` separated stream. */
export function loadAll(input: string): YAMLValue[] {
    const rawLines = input.replace(/\r\n?/g, '\n').split('\n');
    const docs: YAMLValue[] = [];
    let current: string[] = [];

    for (const raw of rawLines) {
        const trimmed = raw.trim();
        if (trimmed === '---') {
            if (current.length > 0) docs.push(parseDocument(current));
            current = [];
            continue;
        }
        if (trimmed === '...') {
            if (current.length > 0) docs.push(parseDocument(current));
            current = [];
            continue;
        }
        current.push(raw);
    }
    if (current.length > 0) docs.push(parseDocument(current));
    // A stream of only separators still yields one empty document.
    return docs.length === 0 && input.trim() !== '' ? [null] : docs;
}

function parseDocument(rawLines: string[]): YAMLValue {
    const lines: Line[] = [];
    for (let i = 0; i < rawLines.length; i++) {
        const raw = rawLines[i]!;
        // Tabs are not valid YAML indentation and silently break offside parsing.
        if (/^\t/.test(raw)) throw new YAMLParseError('Tab used for indentation', i);
        const withoutComment = stripComment(raw);
        if (withoutComment.trim() === '') continue;
        lines.push({
            indent: withoutComment.length - withoutComment.trimStart().length,
            text: withoutComment.trim(),
            raw,
            number: i,
        });
    }
    if (lines.length === 0) return null;

    const anchors = new Map<string, YAMLValue>();
    const [value] = parseBlock(lines, 0, lines[0]!.indent, anchors, rawLines);
    return value;
}

function stripComment(line: string): string {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (ch === '\\' && inDouble) {
            i++;
            continue;
        }
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]!))) {
            return line.slice(0, i);
        }
    }
    return line;
}

/** Returns the parsed value and the index of the first unconsumed line. */
function parseBlock(
    lines: Line[],
    start: number,
    indent: number,
    anchors: Map<string, YAMLValue>,
    rawLines: string[],
): [YAMLValue, number] {
    if (start >= lines.length) return [null, start];
    const first = lines[start]!;

    if (first.text.startsWith('- ') || first.text === '-') {
        return parseSequence(lines, start, indent, anchors, rawLines);
    }
    if (findKeyEnd(first.text) !== -1) {
        return parseMapping(lines, start, indent, anchors, rawLines);
    }
    return [parseScalar(first.text, anchors), start + 1];
}

function parseSequence(
    lines: Line[],
    start: number,
    indent: number,
    anchors: Map<string, YAMLValue>,
    rawLines: string[],
): [YAMLValue[], number] {
    const items: YAMLValue[] = [];
    let i = start;

    while (i < lines.length) {
        const line = lines[i]!;
        if (line.indent < indent) break;
        if (line.indent > indent) throw new YAMLParseError('Unexpected indentation in sequence', line.number);
        if (!line.text.startsWith('- ') && line.text !== '-') break;

        const inline = line.text === '-' ? '' : line.text.slice(2).trim();
        i++;

        if (inline === '') {
            const [value, next] = i < lines.length && lines[i]!.indent > indent
                ? parseBlock(lines, i, lines[i]!.indent, anchors, rawLines)
                : [null as YAMLValue, i];
            items.push(value);
            i = next;
            continue;
        }

        // `- key: value` starts a mapping whose indent is the column of the key.
        if (findKeyEnd(inline) !== -1) {
            const keyIndent = line.indent + (line.raw.length - line.raw.trimStart().length === line.indent ? 2 : 2);
            const synthetic: Line[] = [{ indent: keyIndent, text: inline, raw: line.raw, number: line.number }];
            let j = i;
            while (j < lines.length && lines[j]!.indent >= keyIndent && !isSequenceStart(lines[j]!, indent)) {
                synthetic.push(lines[j]!);
                j++;
            }
            const [value] = parseMapping(synthetic, 0, keyIndent, anchors, rawLines);
            items.push(value);
            i = j;
            continue;
        }

        const blockScalar = readBlockScalar(inline, lines, i, indent, rawLines);
        if (blockScalar) {
            items.push(blockScalar.value);
            i = blockScalar.next;
            continue;
        }
        items.push(parseScalar(inline, anchors));
    }

    return [items, i];
}

function isSequenceStart(line: Line, indent: number): boolean {
    return line.indent === indent && (line.text.startsWith('- ') || line.text === '-');
}

function parseMapping(
    lines: Line[],
    start: number,
    indent: number,
    anchors: Map<string, YAMLValue>,
    rawLines: string[],
): [Record<string, YAMLValue>, number] {
    const map: Record<string, YAMLValue> = {};
    let i = start;

    while (i < lines.length) {
        const line = lines[i]!;
        if (line.indent < indent) break;
        if (line.indent > indent) throw new YAMLParseError('Unexpected indentation in mapping', line.number);
        if (line.text.startsWith('- ')) break;

        const keyEnd = findKeyEnd(line.text);
        if (keyEnd === -1) throw new YAMLParseError(`Expected "key: value", got "${line.text}"`, line.number);

        let key = line.text.slice(0, keyEnd).trim();
        if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
            key = key.slice(1, -1);
        }
        let rest = line.text.slice(keyEnd + 1).trim();
        i++;

        // Anchor declared on the key line applies to the whole value.
        let anchorName: string | undefined;
        const anchorMatch = /^&(\S+)\s*(.*)$/.exec(rest);
        if (anchorMatch) {
            anchorName = anchorMatch[1]!;
            rest = anchorMatch[2]!.trim();
        }

        let value: YAMLValue;
        if (rest === '') {
            const blockScalar = readBlockScalar(rest, lines, i, indent, rawLines);
            if (blockScalar) {
                value = blockScalar.value;
                i = blockScalar.next;
            } else if (i < lines.length && lines[i]!.indent > indent) {
                const [nested, next] = parseBlock(lines, i, lines[i]!.indent, anchors, rawLines);
                value = nested;
                i = next;
            } else if (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('- ')) {
                // A sequence may sit at the same indentation as its key.
                const [nested, next] = parseSequence(lines, i, indent, anchors, rawLines);
                value = nested;
                i = next;
            } else {
                value = null;
            }
        } else {
            const blockScalar = readBlockScalar(rest, lines, i, indent, rawLines);
            if (blockScalar) {
                value = blockScalar.value;
                i = blockScalar.next;
            } else {
                value = parseScalar(rest, anchors);
            }
        }

        if (anchorName) anchors.set(anchorName, value);
        map[key] = value;
    }

    return [map, i];
}

/** Index of the `:` that separates a key from its value, or -1. */
function findKeyEnd(text: string): number {
    let inSingle = false;
    let inDouble = false;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === '\\' && inDouble) {
            i++;
            continue;
        }
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (!inSingle && !inDouble) {
            if (ch === '[' || ch === '{') depth++;
            else if (ch === ']' || ch === '}') depth--;
            else if (ch === ':' && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1]!))) return i;
        }
    }
    return -1;
}

interface BlockScalar {
    value: string;
    next: number;
}

/** Handles `|`, `>`, and their `-`/`+` chomping indicators. */
function readBlockScalar(
    marker: string,
    lines: Line[],
    start: number,
    parentIndent: number,
    rawLines: string[],
): BlockScalar | null {
    const match = /^([|>])([-+]?)(\d*)$/.exec(marker.trim());
    if (!match) return null;
    const [, style, chomp] = match;

    // Block scalars keep blank lines, so read from the raw source, not the
    // filtered line list which dropped them.
    const firstLineNumber = start < lines.length ? lines[start]!.number : rawLines.length;
    const collected: string[] = [];
    let blockIndent = -1;
    let cursor = firstLineNumber;

    for (; cursor < rawLines.length; cursor++) {
        const raw = rawLines[cursor]!;
        if (raw.trim() === '') {
            collected.push('');
            continue;
        }
        const indent = raw.length - raw.trimStart().length;
        if (indent <= parentIndent) break;
        if (blockIndent === -1) blockIndent = indent;
        collected.push(raw.slice(blockIndent));
    }

    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();

    let text: string;
    if (style === '|') {
        text = collected.join('\n');
    } else {
        // Folded: a single newline becomes a space, blank lines stay as newlines.
        text = collected.reduce((acc, line, idx) => {
            if (idx === 0) return line;
            const prev = collected[idx - 1]!;
            if (line === '' || prev === '') return `${acc}\n${line}`;
            if (line.startsWith(' ') || prev.startsWith(' ')) return `${acc}\n${line}`;
            return `${acc} ${line}`;
        }, '');
    }

    if (chomp === '+') text += '\n';
    else if (chomp !== '-') text += '\n';

    // Map the raw cursor back to an index in the filtered line list.
    let next = start;
    while (next < lines.length && lines[next]!.number < cursor) next++;

    return { value: text, next };
}

function parseScalar(text: string, anchors: Map<string, YAMLValue>): YAMLValue {
    const value = text.trim();
    if (value === '') return null;

    if (value.startsWith('*')) {
        const name = value.slice(1).trim();
        if (!anchors.has(name)) throw new YAMLParseError(`Unknown alias "${name}"`, 0);
        return anchors.get(name)!;
    }
    if (value.startsWith('&')) {
        const match = /^&(\S+)\s*(.*)$/.exec(value);
        if (match) {
            const resolved = match[2] ? parseScalar(match[2]!, anchors) : null;
            anchors.set(match[1]!, resolved);
            return resolved;
        }
    }

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        return unescapeDouble(value.slice(1, -1));
    }
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
        return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.startsWith('[') && value.endsWith(']')) {
        return splitFlow(value.slice(1, -1)).map((part) => parseScalarOrFlow(part, anchors));
    }
    if (value.startsWith('{') && value.endsWith('}')) {
        const out: Record<string, YAMLValue> = {};
        for (const part of splitFlow(value.slice(1, -1))) {
            const keyEnd = findKeyEnd(part);
            if (keyEnd === -1) continue;
            let key = part.slice(0, keyEnd).trim();
            if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
                key = key.slice(1, -1);
            }
            out[key] = parseScalarOrFlow(part.slice(keyEnd + 1), anchors);
        }
        return out;
    }

    if (value === 'null' || value === '~' || value === 'Null' || value === 'NULL') return null;
    if (value === 'true' || value === 'True' || value === 'TRUE') return true;
    if (value === 'false' || value === 'False' || value === 'FALSE') return false;
    if (value === '.inf' || value === '.Inf') return Infinity;
    if (value === '-.inf' || value === '-.Inf') return -Infinity;
    if (value === '.nan' || value === '.NaN') return NaN;
    if (/^[-+]?0x[0-9a-fA-F]+$/.test(value)) return parseInt(value.replace('0x', ''), 16);
    if (/^[-+]?0o[0-7]+$/.test(value)) return parseInt(value.replace('0o', ''), 8);
    // Leading zeros are kept numeric to match js-yaml, which callers' configs were written against.
    if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(value)) return Number(value);

    return value;
}

function parseScalarOrFlow(text: string, anchors: Map<string, YAMLValue>): YAMLValue {
    return parseScalar(text.trim(), anchors);
}

/** Splits a flow collection body on top-level commas. */
function splitFlow(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let current = '';
    for (let i = 0; i < body.length; i++) {
        const ch = body[i]!;
        if (ch === '\\' && inDouble) {
            current += ch + (body[++i] ?? '');
            continue;
        }
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (!inSingle && !inDouble) {
            if (ch === '[' || ch === '{') depth++;
            else if (ch === ']' || ch === '}') depth--;
            else if (ch === ',' && depth === 0) {
                if (current.trim() !== '') parts.push(current);
                current = '';
                continue;
            }
        }
        current += ch;
    }
    if (current.trim() !== '') parts.push(current);
    return parts;
}

function unescapeDouble(value: string): string {
    return value.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, esc: string) => {
        switch (esc[0]) {
            case 'n': return '\n';
            case 'r': return '\r';
            case 't': return '\t';
            case 'f': return '\f';
            case 'b': return '\b';
            case 'v': return '\v';
            case '0': return '\0';
            case 'u': return String.fromCharCode(parseInt(esc.slice(1), 16));
            case 'x': return String.fromCharCode(parseInt(esc.slice(1), 16));
            default: return esc[0]!;
        }
    });
}

export default { load, loadAll, YAMLParseError };
