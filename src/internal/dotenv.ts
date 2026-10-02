/**
 * Zero-dependency `.env` loader, replacing `dotenv`.
 *
 * Supports the syntax Lunx users actually write: `KEY=value`, `export KEY=`,
 * single/double/backtick quoting, multi-line quoted values, `#` comments,
 * escape sequences inside double quotes, and `${VAR}` interpolation.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ParseResult {
    [key: string]: string;
}

export interface ConfigOptions {
    /** One or more .env files, in increasing priority. Default `.env`. */
    path?: string | string[];
    /** Overwrite keys already present in `process.env`. Default false. */
    override?: boolean;
    /** Target object to populate. Default `process.env`. */
    processEnv?: NodeJS.ProcessEnv;
    /** Expand `${VAR}` references. Default true. */
    expand?: boolean;
    encoding?: BufferEncoding;
}

export interface ConfigResult {
    parsed?: ParseResult;
    error?: Error;
}

const LINE = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)?$/;

/** Parses `.env` text. Mirrors dotenv's return shape: a flat string map. */
export function parse(input: string | Buffer): ParseResult {
    const out: ParseResult = {};
    const text = input.toString().replace(/\r\n?/g, '\n');
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim() || line.trim().startsWith('#')) continue;

        const match = LINE.exec(line);
        if (!match) continue;
        const key = match[1]!;
        let rest = match[2] ?? '';

        const quote = rest[0];
        if (quote === '"' || quote === "'" || quote === '`') {
            // A quoted value may span lines; consume until the closing quote.
            let value = rest.slice(1);
            let closed = false;
            const closeIndex = findClosingQuote(value, quote);
            if (closeIndex !== -1) {
                value = value.slice(0, closeIndex);
                closed = true;
            }
            while (!closed && i + 1 < lines.length) {
                const next = lines[++i]!;
                const idx = findClosingQuote(next, quote);
                if (idx === -1) {
                    value += `\n${next}`;
                } else {
                    value += `\n${next.slice(0, idx)}`;
                    closed = true;
                }
            }
            out[key] = quote === '"' ? unescape(value) : value;
            continue;
        }

        // Unquoted: everything from the first `#` is a comment, as in dotenv.
        const hash = rest.indexOf('#');
        if (hash !== -1) rest = rest.slice(0, hash);
        out[key] = rest.trim();
    }

    return out;
}

function findClosingQuote(text: string, quote: string): number {
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
            continue;
        }
        if (text[i] === quote) return i;
    }
    return -1;
}

/**
 * dotenv expands only `\n` and `\r` inside double quotes; every other
 * backslash sequence stays verbatim. Matched exactly so existing `.env` files
 * keep parsing the way they did.
 */
function unescape(value: string): string {
    return value.replace(/\\([nr])/g, (_m, esc: string) => (esc === 'n' ? '\n' : '\r'));
}

/** Resolves `${VAR}` / `$VAR` against the parsed map, then the environment. */
export function expand(parsed: ParseResult, env: NodeJS.ProcessEnv = process.env): ParseResult {
    const resolving = new Set<string>();

    const resolve = (key: string, seen: Set<string>): string => {
        const raw = parsed[key];
        if (raw === undefined) return env[key] ?? '';
        if (seen.has(key)) return raw; // circular reference: leave as written
        seen.add(key);
        return raw.replace(/\$(?:\{([\w.-]+)(?::-([^}]*))?\}|([A-Za-z_]\w*))/g, (_m, braced, fallback, bare) => {
            const name = (braced ?? bare) as string;
            const value = parsed[name] !== undefined ? resolve(name, seen) : env[name];
            return value ?? fallback ?? '';
        });
    };

    const out: ParseResult = {};
    for (const key of Object.keys(parsed)) out[key] = resolve(key, new Set(resolving));
    return out;
}

/** dotenv-compatible `config()`. */
export function config(options: ConfigOptions = {}): ConfigResult {
    const files = options.path === undefined ? ['.env'] : Array.isArray(options.path) ? options.path : [options.path];
    const target = options.processEnv ?? process.env;
    const merged: ParseResult = {};

    try {
        for (const file of files) {
            const full = path.resolve(file);
            if (!fs.existsSync(full)) continue;
            Object.assign(merged, parse(fs.readFileSync(full, options.encoding ?? 'utf8')));
        }

        const final = options.expand === false ? merged : expand(merged, target);
        for (const [key, value] of Object.entries(final)) {
            if (options.override || target[key] === undefined) target[key] = value;
        }
        return { parsed: final };
    } catch (error) {
        return { error: error as Error };
    }
}

export default { config, parse, expand };
