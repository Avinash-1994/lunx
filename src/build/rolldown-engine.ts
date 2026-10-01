/**
 * Production build on Rolldown — the Rust bundler that also powers Vite 8.
 *
 * Rolldown does the heavy lifting natively: resolution (exports/imports maps,
 * conditions, tsconfig paths), TS/JSX via oxc, scope hoisting, tree shaking,
 * code splitting and minification. Lunx adds what a web app needs on top:
 * HTML entries, framework compilers (Vue, Svelte, Solid, Preact, Angular…),
 * CSS through LightningCSS (+ PostCSS when the project configures it),
 * static assets, env defines, `public/`, and precompressed output.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { BuildConfig } from '../config/index.js';
import { CSS_LANGS, compileCss, isCssModule, resolveCssFile, type CompiledCss } from './css.js';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|flac|aac|m4a|pdf|txt|wasm)$/i;
const CSS_EXT = CSS_LANGS;
const INLINE_LIMIT = 4096;

export interface BuildArtifact {
    fileName: string;
    type: 'chunk' | 'asset';
    source: string | Uint8Array;
}

export interface RolldownBuildResult {
    success: true;
    engine: 'rolldown';
    durationMs: number;
    artifacts: BuildArtifact[];
    /** Every module that ended up in the bundle (absolute paths). */
    modules: string[];
}

/** Rolldown is a regular dependency, but a broken native binding must not take the CLI down. */
export async function rolldownAvailable(): Promise<boolean> {
    try {
        await import('rolldown');
        return true;
    } catch {
        return false;
    }
}

const hash8 = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex').slice(0, 8);
const cleanId = (id: string) => id.split('?')[0]!;
const toPosix = (p: string) => p.split(path.sep).join('/');

interface HtmlEntry {
    file: string;
    source: string;
    /** script src attribute → rolldown input name */
    scripts: Map<string, string>;
    /** local stylesheets linked from the page */
    styles: string[];
}

export async function rolldownBuild(config: BuildConfig, framework: string): Promise<RolldownBuildResult> {
    const started = performance.now();
    const { rolldown } = await import('rolldown');
    const root = path.resolve(config.root || process.cwd());
    const outDir = path.resolve(root, config.outDir || 'dist');
    const base = ensureSlashes((config as any).base ?? '/');
    const build = config.build ?? {};
    const minify = build.minify !== false;

    // ── Entries ──────────────────────────────────────────────────────────────
    const entries = (config.entry?.length ? config.entry : ['index.html']).map((e) => path.resolve(root, e));
    const input: Record<string, string> = {};
    const htmlEntries: HtmlEntry[] = [];
    const usedNames = new Set<string>();
    const nameFor = (file: string) => {
        let name = path.basename(file).replace(/\.[^.]+$/, '') || 'index';
        for (let i = 2; usedNames.has(name); i++) name = `${name}-${i}`;
        usedNames.add(name);
        return name;
    };

    for (const entry of entries) {
        if (!fs.existsSync(entry)) throw new Error(`Entry not found: ${path.relative(root, entry) || entry}`);
        if (!entry.endsWith('.html')) {
            input[nameFor(entry)] = entry;
            continue;
        }
        const source = await fsp.readFile(entry, 'utf8');
        const html: HtmlEntry = { file: entry, source, scripts: new Map(), styles: [] };
        for (const m of source.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi)) {
            const src = m[1]!;
            if (/^(https?:)?\/\//.test(src)) continue;
            const file = src.startsWith('/') ? path.join(root, src) : path.resolve(path.dirname(entry), src);
            const name = nameFor(file);
            input[name] = file;
            html.scripts.set(src, name);
        }
        for (const m of source.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
            const href = m[1]!;
            if (/^(https?:)?\/\//.test(href)) continue;
            const file = href.startsWith('/') ? path.join(root, href) : path.resolve(path.dirname(entry), href);
            if (fs.existsSync(file) && !isInside(path.join(root, 'public'), file)) html.styles.push(file);
        }
        htmlEntries.push(html);
    }
    if (Object.keys(input).length === 0 && htmlEntries.every((h) => h.styles.length === 0)) {
        throw new Error('No module scripts found in the HTML entry. Add <script type="module" src="/src/main.ts"></script>.');
    }

    // ── Plugins ──────────────────────────────────────────────────────────────
    const css = new CssCollector(root, base, minify);
    const assets = new Map<string, string>(); // source file → public URL
    const emittedAssets: BuildArtifact[] = [];

    const emitAsset = (ctx: any, file: string, data: Buffer): string => {
        const known = assets.get(file);
        if (known) return known;
        const ext = path.extname(file);
        const fileName = `assets/${path.basename(file, ext)}.${hash8(data)}${ext}`;
        ctx.emitFile({ type: 'asset', fileName, source: data });
        const url = base + fileName;
        assets.set(file, url);
        return url;
    };
    css.emitAsset = emitAsset;

    const { UniversalTransformer, looksLikeJsx } = await import('../core/universal-transformer.js');
    const transformer = new UniversalTransformer(root, { cache: false });
    const compileJsx = framework === 'solid' || framework === 'preact' || framework === 'qwik' || framework === 'mithril';

    const plugins: any[] = [
        ...((config as any).__rollupPlugins ?? []),
        ...(config.plugins ?? []).filter((p: any) => p && typeof p === 'object' && (p.resolveId || p.load || p.transform || p.renderChunk || p.generateBundle)),
        {
            name: 'lunx:framework',
            async transform(code: string, id: string) {
                const file = cleanId(id);
                const isSfc = /\.(vue|svelte)$/.test(file);
                const isFrameworkJsx = compileJsx && !file.includes('node_modules') && (/\.[jt]sx$/.test(file) || (/\.m?js$/.test(file) && looksLikeJsx(code)));
                const isAngular = framework === 'angular' && /\.ts$/.test(file) && !file.includes('node_modules');
                if (!isSfc && !isFrameworkJsx && !isAngular) return null;
                const fw = file.endsWith('.vue') ? 'vue' : file.endsWith('.svelte') ? 'svelte' : framework;
                const out = await transformer.transform({ filePath: file, code, framework: fw as any, root, isDev: false });
                return { code: out.code, map: null, moduleType: 'js' };
            },
        },
        {
            // Create React App allowed JSX in `.js`; parse app sources that need it as JSX.
            name: 'lunx:jsx-in-js',
            async transform(code: string, id: string) {
                if (!/\.m?js$/.test(cleanId(id)) || id.includes('node_modules') || !looksLikeJsx(code)) return null;
                if (compileJsx) return null; // the framework compiler above already handled it
                return { code, moduleType: 'jsx' };
            },
        },
        {
            name: 'lunx:css',
            async load(id: string) {
                const file = cleanId(id);
                if (!CSS_EXT.test(file)) return null;
                const query = id.slice(file.length);
                const raw = await fsp.readFile(file, 'utf8');
                if (/[?&]raw\b/.test(query)) return { code: `export default ${JSON.stringify(raw)};`, moduleType: 'js' };
                const result = await css.process(this, file, raw, isCssModule(file));
                if (/[?&]inline\b/.test(query)) return { code: `export default ${JSON.stringify(result.code)};`, moduleType: 'js' };
                css.add(file, result.code);
                const exports = result.exports ? `export default ${JSON.stringify(result.exports)};` : 'export {};';
                return { code: exports, moduleType: 'js', moduleSideEffects: true };
            },
        },
        {
            name: 'lunx:assets',
            async load(id: string) {
                const file = cleanId(id);
                const query = id.slice(file.length);
                const wantsUrl = /[?&]url\b/.test(query);
                const wantsRaw = /[?&]raw\b/.test(query);
                if (!wantsUrl && !wantsRaw && !ASSET_EXT.test(file)) return null;
                if (CSS_EXT.test(file) && !wantsUrl) return null;
                if (wantsRaw) return { code: `export default ${JSON.stringify(await fsp.readFile(file, 'utf8'))};`, moduleType: 'js' };
                const data = await fsp.readFile(file);
                const url = !wantsUrl && data.length < INLINE_LIMIT && !/\.(svg|wasm)$/i.test(file)
                    ? `data:${mimeOf(file)};base64,${data.toString('base64')}`
                    : emitAsset(this, file, data);
                return { code: `export default ${JSON.stringify(url)};`, moduleType: 'js' };
            },
        },
        {
            name: 'lunx:css-emit',
            generateBundle(this: any, _opts: unknown, bundle: Record<string, any>) {
                // Extracted CSS modules are empty JS, so they vanish from
                // chunk.moduleIds; walk the import graph instead. Depth-first
                // in import order is exactly the cascade order of the source.
                const order: string[] = [];
                const visited = new Set<string>();
                const visit = (id: string) => {
                    if (visited.has(id)) return;
                    visited.add(id);
                    const file = cleanId(id);
                    if (css.has(file)) {
                        if (!order.includes(file)) order.push(file);
                        return;
                    }
                    const info = this.getModuleInfo(id);
                    for (const dep of info?.importedIds ?? []) visit(dep);
                    for (const dep of info?.dynamicallyImportedIds ?? []) visit(dep);
                };
                const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
                chunks.sort((x, y) => Number(y.isEntry) - Number(x.isEntry));
                for (const chunk of chunks) if (chunk.facadeModuleId) visit(chunk.facadeModuleId);
                css.order = order;
            },
        },
    ];

    // ── Rolldown ─────────────────────────────────────────────────────────────
    const envDefines: Record<string, string> = { ...((config as any).__envDefines ?? {}) };
    const metaEnv: Record<string, unknown> = {
        ...(safeJson(envDefines['import.meta.env'] ?? '{}') as Record<string, unknown>),
        MODE: config.mode, PROD: config.mode === 'production', DEV: config.mode !== 'production', SSR: false, BASE_URL: base,
    };
    delete envDefines['import.meta.env'];
    const define: Record<string, string> = {
        ...envDefines,
        'process.env.NODE_ENV': JSON.stringify(config.mode === 'production' ? 'production' : config.mode),
        'import.meta.env': JSON.stringify(metaEnv),
        ...Object.fromEntries(Object.entries(metaEnv).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])),
        ...((config as any).define ?? {}),
    };

    const alias = normalizeAlias((config as any).resolve?.alias, root);
    const tsconfig = ['tsconfig.json', 'jsconfig.json'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
    const jsxImportSource = framework === 'preact' ? 'preact' : undefined;

    let bundle: any;
    if (Object.keys(input).length > 0) {
        bundle = await rolldown({
            input,
            cwd: root,
            platform: 'browser',
            plugins,
            ...(tsconfig ? { tsconfig } : {}),
            resolve: {
                ...(alias ? { alias } : {}),
                extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte', '.json'],
                // Never `development`: dev-only builds of React/Vue are 3–10× larger.
                conditionNames: ['browser', 'import', 'module', config.mode === 'production' ? 'production' : 'development', 'default'],
            },
            transform: {
                define,
                ...(jsxImportSource ? { jsx: { runtime: 'automatic', importSource: jsxImportSource } } : {}),
            },
            onLog(level: string, log: any, handler: (level: any, log: any) => void) {
                // Rolldown is chatty about things that are normal in app code.
                if (log.code === 'EVAL' || log.code === 'CIRCULAR_DEPENDENCY' || log.code === 'MIXED_EXPORT') return;
                handler(level, log);
            },
        } as any);
    }

    await emptyDir(outDir, root);

    const manualChunks = build.manualChunks;
    const output: any[] = bundle
        ? (await bundle.write({
              dir: outDir,
              format: 'es',
              entryFileNames: 'assets/[name].[hash].js',
              chunkFileNames: 'assets/[name].[hash].js',
              assetFileNames: 'assets/[name].[hash][extname]',
              minify,
              sourcemap: sourcemapOption(build.sourcemap),
              ...(manualChunks && Object.keys(manualChunks).length
                  ? {
                        advancedChunks: {
                            groups: Object.entries(manualChunks).map(([name, pkgs]) => ({
                                name,
                                test: new RegExp(`[\\\\/]node_modules[\\\\/](${pkgs.map(escapeRe).join('|')})[\\\\/]`),
                            })),
                        },
                    }
                  : {}),
          })).output
        : [];
    await bundle?.close();

    // ── CSS ──────────────────────────────────────────────────────────────────
    const htmlCss = new Map<HtmlEntry, string[]>();
    for (const html of htmlEntries) {
        const files: string[] = [];
        for (const file of html.styles) {
            const result = await css.process({ emitFile: (f: any) => emittedAssets.push({ fileName: f.fileName, type: 'asset', source: f.source }) }, file, await fsp.readFile(file, 'utf8'), false);
            files.push(result.code);
        }
        htmlCss.set(html, files);
    }
    const bundledCss = css.order.map((f) => css.get(f)!).join('\n');
    const pageCss = [...htmlCss.values()].flat().join('\n');
    let cssFile: string | null = null;
    const allCss = [pageCss, bundledCss].filter(Boolean).join('\n');
    if (allCss.trim()) {
        cssFile = `assets/style.${hash8(allCss)}.css`;
        emittedAssets.push({ fileName: cssFile, type: 'asset', source: allCss });
    }
    for (const asset of emittedAssets) {
        await fsp.mkdir(path.dirname(path.join(outDir, asset.fileName)), { recursive: true });
        await fsp.writeFile(path.join(outDir, asset.fileName), asset.source);
    }

    // ── HTML ─────────────────────────────────────────────────────────────────
    const chunkByName = new Map<string, any>();
    for (const item of output) if (item.type === 'chunk' && item.isEntry) chunkByName.set(item.name, item);
    for (const html of htmlEntries) {
        let page = html.source;
        const preloads = new Set<string>();
        for (const [src, name] of html.scripts) {
            const chunk = chunkByName.get(name);
            if (!chunk) continue;
            page = page.replace(new RegExp(`(<script\\b[^>]*\\bsrc=["'])${escapeRe(src)}(["'][^>]*>)`), `$1${base}${chunk.fileName}$2`);
            for (const dep of chunk.imports as string[]) preloads.add(dep);
        }
        page = page.replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>\s*/gi, (tag, href) =>
            html.styles.some((s) => s === (href.startsWith('/') ? path.join(root, href) : path.resolve(path.dirname(html.file), href))) ? '' : tag,
        );
        const head = [
            ...[...preloads].map((f) => `<link rel="modulepreload" crossorigin href="${base}${f}">`),
            ...(cssFile ? [`<link rel="stylesheet" crossorigin href="${base}${cssFile}">`] : []),
        ];
        if (head.length) {
            const tags = head.map((t) => `    ${t}\n`).join('');
            page = /<\/head>/i.test(page) ? page.replace(/<\/head>/i, `${tags}  </head>`) : tags + page;
        }
        const target = path.join(outDir, path.relative(root, html.file));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, page);
        emittedAssets.push({ fileName: toPosix(path.relative(outDir, target)), type: 'asset', source: page });
    }

    // ── public/ ──────────────────────────────────────────────────────────────
    const publicDir = path.resolve(root, (config as any).publicDir ?? 'public');
    if (fs.existsSync(publicDir) && fs.statSync(publicDir).isDirectory()) {
        await fsp.cp(publicDir, outDir, { recursive: true, force: false, errorOnExist: false });
    }

    const artifacts: BuildArtifact[] = [
        ...output.map((o) => ({ fileName: o.fileName, type: o.type, source: o.type === 'chunk' ? o.code : o.source })),
        ...emittedAssets,
    ];

    // ── Precompression (.gz / .br) for static hosts ──────────────────────────
    if (build.compress !== false) {
        const quality = typeof build.compress === 'object' ? build.compress.brotliQuality ?? 9 : 9;
        await Promise.all(
            artifacts
                .filter((a) => /\.(js|mjs|css|html|svg|json)$/.test(a.fileName))
                .map(async (a) => {
                    const data = typeof a.source === 'string' ? Buffer.from(a.source) : Buffer.from(a.source);
                    if (data.length < 1024) return;
                    const file = path.join(outDir, a.fileName);
                    const [gz, br] = await Promise.all([
                        gzip(data, { level: 9 }),
                        brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
                    ]);
                    await Promise.all([fsp.writeFile(`${file}.gz`, gz), fsp.writeFile(`${file}.br`, br)]);
                }),
        );
    }

    const modules = new Set<string>();
    for (const o of output) if (o.type === 'chunk') for (const id of o.moduleIds as string[]) if (path.isAbsolute(cleanId(id))) modules.add(cleanId(id));

    return { success: true, engine: 'rolldown', durationMs: performance.now() - started, artifacts, modules: [...modules] };
}

// ── CSS processing ───────────────────────────────────────────────────────────

class CssCollector {
    private sheets = new Map<string, string>();
    order: string[] = [];
    emitAsset!: (ctx: any, file: string, data: Buffer) => string;

    constructor(private root: string, private base: string, private minify: boolean) {}

    has(file: string) { return this.sheets.has(file); }
    get(file: string) { return this.sheets.get(file); }
    add(file: string, code: string) { this.sheets.set(file, code); }

    process(ctx: any, file: string, source: string, modules: boolean): Promise<CompiledCss> {
        return compileCss({
            root: this.root,
            file,
            source,
            modules,
            minify: this.minify,
            resolveUrl: (from, url) => {
                const clean = url.split(/[?#]/)[0]!;
                if (clean.startsWith('/') && fs.existsSync(path.join(this.root, 'public', clean))) return this.base + clean.slice(1);
                const target = resolveCssFile(this.root, from, url);
                if (!target) return url;
                const data = fs.readFileSync(target);
                if (data.length < INLINE_LIMIT && !/\.svg$/i.test(target)) return `data:${mimeOf(target)};base64,${data.toString('base64')}`;
                return this.emitAsset(ctx, target, data) + url.slice(clean.length);
            },
        });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureSlashes(base: string): string {
    if (/^(https?:)?\/\//.test(base)) return base.endsWith('/') ? base : `${base}/`;
    let b = base.startsWith('/') ? base : `/${base}`;
    if (!b.endsWith('/')) b += '/';
    return b;
}

function isInside(dir: string, file: string): boolean {
    const rel = path.relative(dir, file);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function sourcemapOption(value: unknown): boolean | 'inline' | 'hidden' {
    if (value === 'inline') return 'inline';
    if (value === 'hidden') return 'hidden';
    if (value === 'external' || value === true) return true;
    return false;
}

function normalizeAlias(alias: unknown, root: string): Record<string, string> | null {
    if (!alias) return null;
    const entries: Array<[string, string]> = Array.isArray(alias)
        ? alias.map((a: any) => [String(a.find), String(a.replacement)])
        : Object.entries(alias as Record<string, string>);
    return Object.fromEntries(entries.map(([k, v]) => [k, v.startsWith('.') ? path.resolve(root, v) : v]));
}

const MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.woff': 'font/woff',
    '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.wasm': 'application/wasm',
};
function mimeOf(file: string): string {
    return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Empty the output directory, but never one that contains the project itself. */
async function emptyDir(outDir: string, root: string): Promise<void> {
    if (outDir === root || isInside(outDir, root) || !fs.existsSync(outDir)) {
        await fsp.mkdir(outDir, { recursive: true });
        return;
    }
    for (const entry of await fsp.readdir(outDir)) {
        await fsp.rm(path.join(outDir, entry), { recursive: true, force: true });
    }
}
