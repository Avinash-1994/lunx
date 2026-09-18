/**
 * HTML entry handling (Vite-style).
 *
 * Production builds must not treat index.html as a JS module. They should:
 *  1. Read <script type="module" src="..."> / local stylesheets as graph entries
 *  2. Emit the original HTML shell with those tags rewritten to hashed bundles
 */

import fs from 'fs';
import path from 'path';

export const CONVENTIONAL_SCRIPT_ENTRIES = [
    'src/main.tsx',
    'src/main.ts',
    'src/main.jsx',
    'src/main.js',
    'src/index.tsx',
    'src/index.ts',
    'src/index.jsx',
    'src/index.js',
];

export const HTML_TEMPLATE_CANDIDATES = [
    'index.html',
    'src/index.html',
];

export interface ResolvedHtmlEntries {
    entryPoints: string[];
    htmlTemplates: string[];
}

export interface BundleArtifact {
    type?: string;
    fileName?: string;
    entry?: string;
}

const EXT_CANDIDATES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.scss', '.sass', '.less'];

export function isHtmlPath(filePath: string): boolean {
    return filePath.split(/[?#]/)[0].toLowerCase().endsWith('.html');
}

export function toPosix(p: string): string {
    return p.replace(/\\/g, '/');
}

function isExternalUrl(href: string): boolean {
    const v = href.trim();
    return /^(https?:)?\/\//i.test(v) || v.startsWith('data:') || v.startsWith('blob:');
}

export function publicAssetUrl(fileName: string, publicPath = '/'): string {
    const base = publicPath.endsWith('/') ? publicPath : `${publicPath}/`;
    return `${base}${fileName.replace(/^\/+/, '')}`;
}

export function isMainBundleArtifact(artifact: BundleArtifact): boolean {
    const name = path.basename(artifact.fileName || '');
    if (!name) return false;
    if (name.includes('remoteEntry') || name.startsWith('chunk.')) return false;
    if (artifact.type === 'js') return name.endsWith('.js') && !name.endsWith('.map');
    if (artifact.type === 'css') return name.endsWith('.css') && !name.endsWith('.map');
    return false;
}

function firstExisting(absPath: string): string | null {
    for (const ext of EXT_CANDIDATES) {
        const candidate = absPath + ext;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
}

/** Resolve a script/link href from an HTML file to a project-relative posix path. */
export function resolveHtmlRef(src: string, htmlFileAbs: string, rootDir: string): string | null {
    const cleaned = src.trim().split(/[?#]/)[0];
    if (!cleaned || isExternalUrl(cleaned)) return null;

    const abs = cleaned.startsWith('/')
        ? path.resolve(rootDir, cleaned.slice(1))
        : path.resolve(path.dirname(htmlFileAbs), cleaned);

    const existing = firstExisting(abs);
    if (existing) return toPosix(path.relative(rootDir, existing));

    // Keep the logical path even if the file is missing so rewrite can still match by basename
    return toPosix(path.relative(rootDir, abs));
}

export function extractHtmlModuleEntries(
    htmlContent: string,
    htmlFileAbs: string,
    rootDir: string
): { scripts: string[]; styles: string[] } {
    const scripts: string[] = [];
    const styles: string[] = [];
    const seen = new Set<string>();

    const push = (list: string[], rel: string | null) => {
        if (!rel || seen.has(rel)) return;
        seen.add(rel);
        list.push(rel);
    };

    const scriptRe = /<script\b([^>]*)>/gi;
    let match: RegExpExecArray | null;
    while ((match = scriptRe.exec(htmlContent))) {
        const attrs = match[1] || '';
        if (!/\btype\s*=\s*(['"]?)module\1/i.test(attrs)) continue;
        const srcMatch = attrs.match(/\bsrc\s*=\s*(['"])(.*?)\1/i);
        if (!srcMatch) continue;
        push(scripts, resolveHtmlRef(srcMatch[2], htmlFileAbs, rootDir));
    }

    const linkRe = /<link\b([^>]*)>/gi;
    while ((match = linkRe.exec(htmlContent))) {
        const attrs = match[1] || '';
        if (!/\brel\s*=\s*(['"]?)stylesheet\1/i.test(attrs)) continue;
        const hrefMatch = attrs.match(/\bhref\s*=\s*(['"])(.*?)\1/i);
        if (!hrefMatch) continue;
        push(styles, resolveHtmlRef(hrefMatch[2], htmlFileAbs, rootDir));
    }

    return { scripts, styles };
}

function conventionalEntries(rootDir: string): string[] {
    return CONVENTIONAL_SCRIPT_ENTRIES.filter((rel) => fs.existsSync(path.join(rootDir, rel)));
}

export function discoverHtmlTemplates(rootDir: string, extra: string[] = []): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const rel of [...extra, ...HTML_TEMPLATE_CANDIDATES]) {
        const posix = toPosix(rel);
        if (seen.has(posix)) continue;
        if (!fs.existsSync(path.join(rootDir, posix))) continue;
        seen.add(posix);
        out.push(posix);
    }
    return out;
}

/**
 * Replace HTML entries with the JS/CSS modules they reference.
 * Always records existing index.html templates so the emit step can preserve the real shell.
 */
export function expandHtmlEntries(entries: string[], rootDir: string): ResolvedHtmlEntries {
    const expanded: string[] = [];
    const htmlFromEntries: string[] = [];

    for (const entry of entries) {
        if (!isHtmlPath(entry)) {
            expanded.push(toPosix(entry));
            continue;
        }
        const relHtml = toPosix(entry);
        htmlFromEntries.push(relHtml);
        const absHtml = path.isAbsolute(entry) ? entry : path.resolve(rootDir, entry);
        let content = '';
        try {
            content = fs.readFileSync(absHtml, 'utf-8');
        } catch {
            continue;
        }
        const { scripts, styles } = extractHtmlModuleEntries(content, absHtml, rootDir);
        const resolved = [...scripts, ...styles].filter((rel) => fs.existsSync(path.join(rootDir, rel)));
        if (resolved.length > 0) {
            expanded.push(...resolved);
        } else {
            expanded.push(...conventionalEntries(rootDir));
        }
    }

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const item of expanded) {
        const key = toPosix(item);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(key);
    }

    if (unique.length === 0 && htmlFromEntries.length > 0) {
        for (const item of conventionalEntries(rootDir)) {
            if (!seen.has(item)) {
                seen.add(item);
                unique.push(item);
            }
        }
    }

    const htmlTemplates = discoverHtmlTemplates(rootDir, htmlFromEntries);
    // Stylesheets referenced from the HTML shell must be graph entries even when
    // the user already pointed `entry` at a JS file.
    for (const rel of htmlTemplates) {
        const abs = path.resolve(rootDir, rel);
        try {
            const content = fs.readFileSync(abs, 'utf-8');
            const { styles } = extractHtmlModuleEntries(content, abs, rootDir);
            for (const item of styles) {
                if (!fs.existsSync(path.join(rootDir, item)) || seen.has(item)) continue;
                seen.add(item);
                unique.push(item);
            }
        } catch {
            // ignore unreadable templates
        }
    }

    return {
        entryPoints: unique,
        htmlTemplates,
    };
}

function entryBasename(entry: string): string {
    return path.basename(entry, path.extname(entry));
}

export function artifactMatchesEntry(artifact: BundleArtifact, entryRel: string): boolean {
    if (!artifact.fileName) return false;
    const posixEntry = toPosix(entryRel);
    if (artifact.entry) {
        const posixArt = toPosix(artifact.entry);
        if (posixArt === posixEntry) return true;
        if (path.basename(posixArt) === path.basename(posixEntry) && entryBasename(posixArt) === entryBasename(posixEntry)) {
            return true;
        }
    }
    const name = path.basename(artifact.fileName);
    const hashed = name.match(/^([^./]+)\.[a-f0-9]{8}\.bundle\.(js|css)$/i);
    if (hashed && hashed[1] === entryBasename(posixEntry)) return true;
    return name.startsWith(entryBasename(posixEntry) + '.');
}

function findMatchingArtifact(
    artifacts: BundleArtifact[],
    type: 'js' | 'css',
    entryRel: string | null
): BundleArtifact | undefined {
    const pool = artifacts.filter((a) => a.type === type && isMainBundleArtifact(a));
    if (entryRel) {
        const hit = pool.find((a) => artifactMatchesEntry(a, entryRel));
        if (hit) return hit;
    }
    return pool.length === 1 ? pool[0] : undefined;
}

/**
 * Rewrite a source HTML shell so module scripts / local stylesheets point at hashed build artifacts.
 * Unmatched main bundles are injected so CSS imported from JS still loads.
 */
export function rewriteHtmlForProduction(
    html: string,
    artifacts: BundleArtifact[],
    opts: { publicPath?: string; htmlFileAbs: string; rootDir: string }
): string {
    const publicPath = opts.publicPath ?? '/';
    const used = new Set<string>();
    const mainJs = artifacts.filter((a) => a.type === 'js' && isMainBundleArtifact(a));
    const mainCss = artifacts.filter((a) => a.type === 'css' && isMainBundleArtifact(a));

    let out = html.replace(/<script\b([^>]*)>/gi, (full, attrs: string) => {
        if (!/\btype\s*=\s*(['"]?)module\1/i.test(attrs)) return full;
        const srcMatch = attrs.match(/\bsrc\s*=\s*(['"])(.*?)\1/i);
        if (!srcMatch) return full;
        const src = srcMatch[2];
        if (isExternalUrl(src)) return full;
        const entryRel = resolveHtmlRef(src, opts.htmlFileAbs, opts.rootDir);
        const artifact = findMatchingArtifact(mainJs, 'js', entryRel);
        if (!artifact?.fileName) return full;
        used.add(artifact.fileName);
        const url = publicAssetUrl(artifact.fileName, publicPath);
        return full.replace(srcMatch[0], `src="${url}"`);
    });

    out = out.replace(/<link\b([^>]*)>/gi, (full, attrs: string) => {
        if (!/\brel\s*=\s*(['"]?)stylesheet\1/i.test(attrs)) return full;
        const hrefMatch = attrs.match(/\bhref\s*=\s*(['"])(.*?)\1/i);
        if (!hrefMatch) return full;
        const href = hrefMatch[2];
        if (isExternalUrl(href)) return full;
        const entryRel = resolveHtmlRef(href, opts.htmlFileAbs, opts.rootDir);
        const artifact = findMatchingArtifact(mainCss, 'css', entryRel);
        if (!artifact?.fileName) return full;
        used.add(artifact.fileName);
        const url = publicAssetUrl(artifact.fileName, publicPath);
        return full.replace(hrefMatch[0], `href="${url}"`);
    });

    const cssTags = mainCss
        .filter((a) => a.fileName && !used.has(a.fileName))
        .map((a) => `    <link rel="stylesheet" href="${publicAssetUrl(a.fileName!, publicPath)}">`)
        .join('\n');
    const jsTags = mainJs
        .filter((a) => a.fileName && !used.has(a.fileName))
        .map((a) => `    <script type="module" src="${publicAssetUrl(a.fileName!, publicPath)}"></script>`)
        .join('\n');

    if (cssTags) {
        if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${cssTags}\n</head>`);
        else out = cssTags + '\n' + out;
    }
    if (jsTags) {
        if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${jsTags}\n</body>`);
        else out = out + '\n' + jsTags;
    }

    return out;
}

export function fallbackHtmlShell(artifacts: BundleArtifact[], publicPath = '/'): string {
    const scripts = artifacts
        .filter((a) => a.type === 'js' && isMainBundleArtifact(a))
        .map((a) => `    <script type="module" src="${publicAssetUrl(a.fileName!, publicPath)}"></script>`)
        .join('\n');
    const links = artifacts
        .filter((a) => a.type === 'css' && isMainBundleArtifact(a))
        .map((a) => `    <link rel="stylesheet" href="${publicAssetUrl(a.fileName!, publicPath)}">`)
        .join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Lunx Build</title>
${links}
</head>
<body>
    <div id="root"></div>
    <div id="app"></div>
${scripts}
</body>
</html>`;
}
