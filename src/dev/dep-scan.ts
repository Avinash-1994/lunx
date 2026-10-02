/**
 * Find the bare imports an app actually uses, by crawling its sources from the
 * HTML entry. Pre-bundling every package.json dependency instead made dev boot
 * scale with the size of the dependency list rather than with the app.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { applyAlias, type AliasEntry } from '../config/aliases.js';

const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.vue', '.svelte'];
const IMPORT_RE = /(?:^|[^.\w$])(?:import|export)\s*(?:[\w*{}\s,$]*?\s*from\s*)?["']([^"'\n]+)["']|(?:^|[^.\w$])import\s*\(\s*["']([^"'\n]+)["']\s*\)|(?:^|[^.\w$])require\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const COMMENT_RE = /\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g;

export interface ScanResult {
    deps: Set<string>;
    files: number;
}

export async function scanDeps(root: string, entries: string[], aliases: AliasEntry[] = [], limit = 5000): Promise<ScanResult> {
    const deps = new Set<string>();
    const seen = new Set<string>();
    const queue: string[] = [];

    for (const entry of entries) {
        const file = path.resolve(root, entry);
        if (!fs.existsSync(file)) continue;
        if (file.endsWith('.html')) {
            const html = await fsp.readFile(file, 'utf8');
            for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
                const src = m[1]!;
                if (/^(https?:)?\/\//.test(src)) continue;
                queue.push(src.startsWith('/') ? path.join(root, src) : path.resolve(path.dirname(file), src));
            }
            for (const m of html.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)) collect(m[1]!, file);
        } else {
            queue.push(file);
        }
    }

    function collect(code: string, from: string) {
        const body = code.replace(COMMENT_RE, '$1');
        for (const m of body.matchAll(IMPORT_RE)) {
            let spec = m[1] ?? m[2] ?? m[3];
            if (!spec || spec.startsWith('data:') || /^(https?:)?\/\//.test(spec) || spec.startsWith('node:')) continue;
            const aliased = !spec.startsWith('.') ? applyAlias(spec, aliases) : null;
            if (aliased) {
                if (path.isAbsolute(aliased)) {
                    const resolved = resolveFile(aliased);
                    if (resolved) queue.push(resolved);
                    continue;
                }
                spec = aliased;
            }
            if (spec.startsWith('.') || spec.startsWith('/')) {
                const target = spec.startsWith('/') ? path.join(root, spec) : path.resolve(path.dirname(from), spec);
                const resolved = resolveFile(target.split('?')[0]!);
                if (resolved) queue.push(resolved);
            } else if (!spec.startsWith('#') && !spec.startsWith('virtual:') && !spec.startsWith('\0')) {
                deps.add(spec.split('?')[0]!);
            }
        }
    }

    while (queue.length > 0 && seen.size < limit) {
        const file = queue.pop()!;
        if (seen.has(file) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
        seen.add(file);
        if (!SOURCE_EXT.includes(path.extname(file))) continue;
        let code: string;
        try {
            code = await fsp.readFile(file, 'utf8');
        } catch {
            continue;
        }
        if (file.endsWith('.vue') || file.endsWith('.svelte')) {
            code = [...code.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
        }
        collect(code, file);
    }

    return { deps, files: seen.size };
}

function resolveFile(base: string): string | null {
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
    for (const ext of SOURCE_EXT) if (fs.existsSync(base + ext)) return base + ext;
    for (const ext of SOURCE_EXT) {
        const index = path.join(base, `index${ext}`);
        if (fs.existsSync(index)) return index;
    }
    // TypeScript's "import './x.js' resolves ./x.ts" convention
    const m = base.match(/^(.*)\.(m?js|jsx)$/);
    if (m) for (const ext of ['.ts', '.tsx', '.mts']) if (fs.existsSync(m[1] + ext)) return m[1] + ext;
    return null;
}
