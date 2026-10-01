import fs from 'node:fs';
import path from 'node:path';

export interface AliasEntry {
    find: string;
    replacement: string;
}

/**
 * Aliases from `resolve.alias` plus tsconfig/jsconfig `compilerOptions.paths`,
 * longest prefix first. Replacements are absolute paths (or bare specifiers).
 */
export function collectAliases(root: string, configured?: unknown): AliasEntry[] {
    const entries: AliasEntry[] = [];
    const add = (find: string, replacement: string) => {
        if (!find || entries.some((e) => e.find === find)) return;
        const abs = replacement.startsWith('.') || path.isAbsolute(replacement) ? path.resolve(root, replacement) : replacement;
        entries.push({ find, replacement: abs });
    };

    if (Array.isArray(configured)) {
        for (const a of configured as any[]) if (typeof a?.find === 'string' && typeof a?.replacement === 'string') add(a.find, a.replacement);
    } else if (configured && typeof configured === 'object') {
        for (const [find, replacement] of Object.entries(configured as Record<string, unknown>)) {
            if (typeof replacement === 'string') add(find, replacement);
        }
    }

    for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const file = path.join(root, name);
        if (!fs.existsSync(file)) continue;
        let options: any;
        try {
            options = parseJsonc(fs.readFileSync(file, 'utf8'))?.compilerOptions;
        } catch {
            continue;
        }
        const baseUrl = path.resolve(root, options?.baseUrl ?? '.');
        for (const [pattern, targets] of Object.entries((options?.paths ?? {}) as Record<string, string[]>)) {
            const target = targets?.[0];
            if (!target) continue;
            // "@/*": ["src/*"]  →  "@" → <root>/src
            const find = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
            const to = target.endsWith('/*') ? target.slice(0, -2) : target;
            if (find.includes('*') || to.includes('*')) continue;
            add(find, path.resolve(baseUrl, to));
        }
        break;
    }

    return entries.sort((a, b) => b.find.length - a.find.length);
}

/** Apply the first matching alias, or return null. */
export function applyAlias(specifier: string, aliases: AliasEntry[]): string | null {
    for (const { find, replacement } of aliases) {
        if (specifier === find) return replacement;
        if (specifier.startsWith(find.endsWith('/') ? find : `${find}/`)) {
            const rest = specifier.slice(find.length).replace(/^\//, '');
            return path.isAbsolute(replacement) ? path.join(replacement, rest) : `${replacement}/${rest}`;
        }
    }
    return null;
}

/** tsconfig allows comments and trailing commas. */
function parseJsonc(text: string): any {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (inString) {
            out += c;
            if (c === '\\') out += text[++i] ?? '';
            else if (c === '"') inString = false;
        } else if (c === '"') {
            inString = true;
            out += c;
        } else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
        } else if (c === '/' && text[i + 1] === '*') {
            i = text.indexOf('*/', i + 2);
            if (i === -1) break;
            i++;
        } else {
            out += c;
        }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
