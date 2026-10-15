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
import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BuildConfig } from '../config/index.js';
import { getBundler, parse, type OutputItem } from '../engines/index.js';
import { dynamicImportVarsPlugin } from '../engines/rolldown.js';
import { resolveTargets } from './targets.js';
import { CompilePool, MIN_POOL_FILES, type Compiled } from './compile-pool.js';
import { transformGlobImports } from './glob-import.js';
import { TransformCache } from './build-cache.js';
import { configureRemoteCache } from './remote-cache.js';
import { federationEnginePlugin, federationInputs, writeRemoteEntry, type FederationOptions } from '../federation/engine.js';
import { consumeRemoteTypes, dtsSides, generateRemoteTypes } from '../federation/types.js';
import { looksLikeJsx } from '../core/jsx-detect.js';
import { CSS_LANGS, compileCss, isCssModule, resolveCssFile, type CompiledCss } from './css.js';
import { metaEnvFrom, replaceHtmlEnv } from './html-env.js';
import { wasmInitModule } from './wasm-init.js';
import { SVG_COMPONENT_QUERY, svgComponent, svgRuntimeFor } from './svg-component.js';
import { pwaFiles, pwaHeadTags, pwaOptions, writeServiceWorker } from './pwa.js';
import type { AppPlugins } from '../plugin-host/app-plugins.js';
import { log } from '../utils/logger.js';

// zlib (~8ms to load) is first needed after the bundle; the engine-busy hook loads it while Rolldown works.
let zlibModule: Promise<typeof import('node:zlib')> | null = null;
const loadZlib = () => (zlibModule ??= import('node:zlib').then((m) => m.default ?? m));

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|flac|aac|m4a|pdf|txt|wasm)$/i;
const CSS_EXT = CSS_LANGS;
const DEFAULT_INLINE_LIMIT = 4096;

export interface BuildArtifact {
    fileName: string;
    type: 'chunk' | 'asset';
    source: string | Uint8Array;
}

export interface ProductionBuildResult {
    success: true;
    /** Name of the bundler that produced it (see src/engines). */
    engine: string;
    durationMs: number;
    artifacts: BuildArtifact[];
    /** Every module that ended up in the bundle (absolute paths). */
    modules: string[];
    /** With `deferCompression`: compress the HTML pages as they are now, and wait for the rest. */
    finishCompression?: () => Promise<void>;
    /** With `deferAfterWrite`: run the plugins' writeBundle / closeBundle. */
    afterWrite?: () => Promise<void>;
}

export interface ProductionBuildOptions {
    /**
     * Called once Rolldown has the module graph and is rendering and
     * minifying in Rust: the main thread is idle until the bundle is done,
     * so work started here costs the build no time.
     */
    onEngineBusy?: () => void;
    /**
     * Return before the .gz / .br copies are written. They are written
     * alongside whatever the caller does next, except the HTML pages, which
     * `finishCompression` compresses after the caller has rewritten them
     * (SRI, CSP).
     */
    deferCompression?: boolean;
    /**
     * Leave the plugins' writeBundle / closeBundle to the caller (`afterWrite`),
     * to run once it has finished rewriting the pages.
     */
    deferAfterWrite?: boolean;
}

/** The bundler is a regular dependency, but a broken native binding must not take the CLI down. */
export function bundlerAvailable(): Promise<boolean> {
    return getBundler().available();
}

async function precompress(file: string, data: Buffer, brotliQuality: number): Promise<void> {
    if (data.length < 1024) return;
    const zlib = await loadZlib();
    const [gz, br] = await Promise.all([
        promisify(zlib.gzip)(data, { level: 9 }),
        promisify(zlib.brotliCompress)(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }),
    ]);
    await Promise.all([fsp.writeFile(`${file}.gz`, gz), fsp.writeFile(`${file}.br`, br)]);
}

const hash8 = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex').slice(0, 8);
/** The stylesheet module a Vue / Svelte component's CSS is imported under (`App.vue?lunx-component.css`). */
export const COMPONENT_CSS = /[?&]lunx-component\.css$/;
const cleanId = (id: string) => id.split('?')[0]!;
const toPosix = (p: string) => p.split(path.sep).join('/');

interface HtmlEntry {
    file: string;
    source: string;
    /** script src attribute → bundler input name */
    scripts: Map<string, string>;
    /** local stylesheets linked from the page */
    styles: string[];
}

export async function productionBuild(config: BuildConfig, framework: string, options: ProductionBuildOptions = {}): Promise<ProductionBuildResult> {
    const started = performance.now();
    const root = path.resolve(config.root || process.cwd());
    const outDir = path.resolve(root, config.outDir || 'dist');
    let base = ensureSlashes((config as any).base ?? '/');
    const build = config.build ?? {};
    const minify = build.minify !== false;
    const cssCodeSplit = (build as any).cssCodeSplit !== false;
    const inlineLimit = build.assetsInlineLimit ?? DEFAULT_INLINE_LIMIT;

    // Third-party license notices: in the code, dropped, or (default) beside each chunk.
    const legalComments: 'inline' | 'none' | 'linked' = minify ? ((build as any).legalComments ?? 'linked') : 'inline';

    // A shared cache for compile results (`cache.remote`).
    configureRemoteCache((config as any).cache?.remote);

    // Vite plugins (from vite.config or lunx.config), with Vite's lifecycle.
    const app = await resolveVitePlugins(config, root, outDir);
    const vp = app && (await import('../plugin-host/app-plugins.js'));
    // A plugin's `config` hook may set it (vite-plugin-electron: `./`, for pages loaded from disk).
    if (app?.userConfig.base !== undefined) base = ensureSlashes(app.userConfig.base);

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

    // Script-only entries still get a page: the project's index.html when it
    // has one (it already references the script), otherwise a minimal page.
    const federation = (config as any).federation as FederationOptions | undefined;
    const exposesOnly = !!federation?.exposes && Object.keys(federation.exposes).length > 0 && !config.entry?.length;
    if (exposesOnly && !fs.existsSync(path.join(root, 'index.html'))) entries.length = 0;
    let syntheticHtml: string | null = null;
    if (entries.length && !entries.some((e) => e.endsWith('.html'))) {
        const rootHtml = path.join(root, 'index.html');
        if (fs.existsSync(rootHtml)) {
            const html = fs.readFileSync(rootHtml, 'utf8');
            const referenced = entries.filter((e) => html.includes('/' + toPosix(path.relative(root, e))));
            entries.splice(0, entries.length, rootHtml, ...entries.filter((e) => !referenced.includes(e)));
        } else {
            syntheticHtml = path.join(root, 'index.html');
        }
    }

    // A web app manifest and service worker (an installed vite-plugin-pwa keeps them).
    const pwa = app?.plugins.some((p: any) => typeof p.name === 'string' && p.name.startsWith('vite-plugin-pwa')) ? null : pwaOptions((config as any).pwa);
    // `%VITE_APP_TITLE%`, `%MODE%`… in the pages.
    const htmlEnv = { ...metaEnvFrom((config as any).__envDefines), MODE: config.mode, PROD: config.mode === 'production', DEV: config.mode !== 'production', BASE_URL: base };
    for (const entry of entries) {
        if (!fs.existsSync(entry)) throw new Error(`Entry not found: ${path.relative(root, entry) || entry}`);
        if (!entry.endsWith('.html')) {
            input[nameFor(entry)] = entry;
            continue;
        }
        let source = replaceHtmlEnv(await fsp.readFile(entry, 'utf8'), htmlEnv);
        if (vp) source = await vp.transformIndexHtml(app!, 'pre', source, { path: '/' + toPosix(path.relative(root, entry)), filename: entry });
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
    if (syntheticHtml) {
        const scripts = new Map<string, string>();
        for (const name of Object.keys(input)) scripts.set(`/__lunx_entry_${name}`, name);
        const tags = [...scripts.keys()].map((src) => `    <script type="module" src="${src}"></script>`).join('\n');
        htmlEntries.push({
            file: syntheticHtml,
            source: `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  </head>\n  <body>\n    <div id="root"></div>\n    <div id="app"></div>\n${tags}\n  </body>\n</html>\n`,
            scripts,
            styles: [],
        });
    }
    const appEntries = new Set(Object.values(input));
    if (federation) Object.assign(input, federationInputs(federation, root));
    // The remotes' type hints, fetched while this app builds.
    const remoteTypes = federation && dtsSides(federation).consume ? consumeRemoteTypes(root, federation).catch(() => []) : null;
    if (Object.keys(input).length === 0 && htmlEntries.every((h) => h.styles.length === 0)) {
        throw new Error('No module scripts found in the HTML entry. Add <script type="module" src="/src/main.ts"></script>.');
    }

    // ── Plugins ──────────────────────────────────────────────────────────────
    // Browsers to compile for: `build.target`, else the project's browserslist, else as written.
    const targets = resolveTargets(root, (build as any).target ?? (build as any).targets, (build as any).cssTarget);
    const css = new CssCollector(root, base, minify, inlineLimit, targets.css);
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
    // CSS a plugin hands to Vite's CSS plugin itself (UnoCSS's generated layers, from renderChunk) goes to lunx's.
    const cssPost = app?.config.plugins.find((p: any) => p.name === 'vite:css-post');
    if (cssPost) {
        cssPost.transform = {
            async handler(this: any, code: string, id: string) {
                const file = cleanId(id);
                css.add(file, (await css.process(this, file, code, false)).code, id);
                return { code: '', map: null };
            },
        };
    }

    // Loaded on first use: only Vue/Svelte/Solid/Angular/… sources need it,
    // and importing it costs ~50ms that a React or vanilla build never uses.
    let transformerPromise: Promise<any> | null = null;
    const getTransformer = () =>
        (transformerPromise ??= import('../core/universal-transformer.js').then((m) => new m.UniversalTransformer(root, { cache: false })));
    const compileJsx = framework === 'solid' || framework === 'preact' || framework === 'qwik' || framework === 'mithril';
    // Framework compiler output on disk: a rebuild recompiles only the components that changed.
    const compileCache = process.env.LUNX_BUILD_CACHE === '0' || (config.build as any)?.cache === false
        ? null
        : new TransformCache(root, 'framework', compilerSalt(root, framework, config.mode ?? 'production'));
    const frameworkOf = (file: string): string => (file.endsWith('.vue') ? 'vue' : file.endsWith('.svelte') ? 'svelte' : framework);
    // Sources whose compiled output depends only on themselves (not Angular, which inlines
    // templateUrl / styleUrls, nor SFC blocks that pull in another file with src="…").
    const selfContained = (code: string): boolean => !/<(?:template|script|style)\b[^>]*\bsrc=/.test(code);
    // Many components to compile: start worker threads on them now, before Rolldown asks.
    // Angular stays on the main thread (its compiler reads other files itself).
    const compilePool = framework === 'angular' || !compilesInJs() ? null : await startCompilePool();
    /** Whether any source can need the JS compilers (React, Lit… compile in Rolldown): else no file scan. */
    function compilesInJs(): boolean {
        if (compileJsx || framework === 'vue' || framework === 'svelte') return true;
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            return 'vue' in deps || 'svelte' in deps;
        } catch {
            return true;
        }
    }
    async function startCompilePool(): Promise<CompilePool | null> {
        const files = CompilePool.candidates(fs.realpathSync(root), compileJsx ? /\.(vue|svelte|[jt]sx)$/ : /\.(vue|svelte)$/, config.outDir);
        if (!files || files.length < MIN_POOL_FILES) return null;
        const todo: Array<[string, string]> = [];
        await Promise.all(files.map(async (file) => {
            const code = await fsp.readFile(file, 'utf8').catch(() => null);
            if (code === null) return;
            if (compileCache && selfContained(code) && (await compileCache.get([file, frameworkOf(file), code]))) return;
            todo.push([file, code]);
        }));
        if (todo.length < MIN_POOL_FILES) return null;
        const pool = CompilePool.start(root, framework === 'vue' || framework === 'svelte' ? [framework] : []);
        for (const [file, code] of todo) pool.prefetch(file, code, frameworkOf(file));
        return pool;
    }

    // Angular: compiled ahead of time with the project's @angular/compiler-cli, as `ng build` does.
    const ngAot = framework === 'angular' && config.mode === 'production' ? await prepareAngular() : null;
    async function prepareAngular() {
        const { prepareAngularAot } = await import('./angular/aot.js');
        const aot = await prepareAngularAot({
            root,
            entries: Object.values(input),
            sourcemap: !!build.sourcemap,
            cache: compileCache !== null,
            compileStyle: async (file, source) => (await compileCss({ root, file, source, modules: false, minify, resolveUrl: (_from, url) => url })).code,
        });
        if (!aot) log.warn('Angular: @angular/compiler-cli is not installed, so the app is compiled at runtime (JIT) and ships @angular/compiler. Install it for an ahead-of-time build.');
        return aot;
    }

    /**
     * `?worker` / `?sharedworker` imports: the default export constructs the
     * worker (`new MyWorker({ name })`); `&url` exports its URL, and `&inline`
     * puts the bundled worker in a blob URL (a separate one-file build).
     */
    async function workerModule(ctx: any, file: string, shared: boolean, query: string): Promise<string> {
        const ctor = shared ? 'SharedWorker' : 'Worker';
        if (/[?&]inline\b/.test(query)) {
            const [chunk] = (await getBundler().bundle(
                { input: { worker: file }, cwd: root, platform: 'browser', plugins: [], define: { 'process.env.NODE_ENV': JSON.stringify(config.mode === 'production' ? 'production' : config.mode) }, extensions: ['.ts', '.tsx', '.js', '.mjs', '.jsx', '.json'] },
                { format: 'iife', minify, inlineDynamicImports: true },
            )).filter((o) => o.type === 'chunk') as any[];
            ctx.addWatchFile?.(file);
            const source = JSON.stringify(chunk.code);
            return `const source = ${source};\nexport default function WorkerWrapper(options) {\n  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));\n  try { return new ${ctor}(url, { name: options?.name }); } finally { URL.revokeObjectURL(url); }\n}\n`;
        }
        const ref = ctx.emitFile({ type: 'chunk', id: file, name: path.basename(file).replace(/\.[^.]+$/, '') });
        const url = `new URL(__LUNX_FILE_URL_${ref}__, import.meta.url)`;
        if (/[?&]url\b/.test(query)) return `export default ${url}.href;\n`;
        return `export default function WorkerWrapper(options) {\n  return new ${ctor}(${url}, { type: 'module', name: options?.name });\n}\n`;
    }

    /** Vue / Svelte components' CSS, by the module id each component imports it under. */
    const componentCss = new Map<string, string>();

    /** A stylesheet as a module: compiled (plugins' transforms around lunx's compiler), collected for the CSS file. */
    const stylesheetModule = async (ctx: any, id: string, raw: string) => {
        const file = cleanId(id);
        const query = id.slice(file.length);
        if (vp) raw = await vp.transformCss(app!, 'pre', ctx, raw, id);
        const result = await css.process(ctx, file, raw, isCssModule(file));
        if (vp) result.code = await vp.transformCss(app!, 'post', ctx, result.code, id);
        if (/[?&]inline\b/.test(query)) return { code: `export default ${JSON.stringify(result.code)};`, moduleType: 'js' };
        css.add(file, result.code, id);
        const exports = result.exports ? `export default ${JSON.stringify(result.exports)};` : 'export {};';
        return { code: exports, moduleType: 'js', moduleSideEffects: true };
    };
    // Stylesheets a plugin loads (UnoCSS's virtual:uno.css) are compiled and collected like files.
    const pluginCss = {
        load: (ctx: any, id: string, code: string) => stylesheetModule(ctx, id, code),
        of(ctx: any, chunk: any): string[] {
            const found = new Set<string>();
            for (const id of chunk.moduleIds ?? []) for (const dep of ctx.getModuleInfo(id)?.importedIds ?? []) if (css.has(cleanId(dep))) found.add(dep);
            return [...found];
        },
    };

    /** The app's CSS file: the pages' stylesheets, then the imported ones in cascade order. */
    const collectCss = async (ctx: any): Promise<string> => {
        const pages: string[] = [];
        for (const html of htmlEntries) {
            for (const file of html.styles) {
                let raw = await fsp.readFile(file, 'utf8');
                if (vp) raw = await vp.transformCss(app!, 'pre', ctx, raw, file);
                const result = await css.process(ctx, file, raw, false);
                pages.push(vp ? await vp.transformCss(app!, 'post', ctx, result.code, file) : result.code);
            }
        }
        const sep = minify ? '' : '\n';
        return [...pages, ...css.order.map((f) => css.get(f)!)].filter(Boolean).join(sep);
    };
    let cssFile: string | null = null;
    /** A lazy chunk's own stylesheet (CSS code splitting), for the manifest. */
    const chunkCss = new Map<string, string>();

    const alias = normalizeAlias([...toAliasList((config as any).resolve?.alias), ...toAliasList(app?.config.resolve.alias)], root);
    // `` import(`./locales/${lang}.js`) ``: every file the pattern matches, as lazy chunks.
    const dynamicImportVars = await dynamicImportVarsPlugin((id, importer) => {
        for (const [find, replacement] of Object.entries(alias ?? {})) {
            if (id !== find && !id.startsWith(find.endsWith('/') ? find : `${find}/`)) continue;
            const target = path.isAbsolute(replacement) ? replacement + id.slice(find.length) : null;
            if (!target) return undefined;
            const rel = toPosix(path.relative(path.dirname(importer), target));
            return rel.startsWith('.') ? rel : `./${rel}`;
        }
        return undefined;
    });

    const plugins: any[] = [
        // Vite's order: `enforce: 'pre'`, the built-ins, the rest, `enforce: 'post'`.
        ...(vp ? vp.forRolldown(app!, app!.pre, pluginCss) : []),
        {
            name: 'lunx:framework',
            // Hook filters keep Rolldown from calling into JS for modules a
            // plugin would ignore anyway (one Rust<->JS round trip per module).
            transform: {
              filter: { id: { include: compileJsx || framework === 'angular' ? /\.(vue|svelte|[mc]?[jt]sx?)(\?.*)?$/ : /\.(vue|svelte)(\?.*)?$/, exclude: [/node_modules/, COMPONENT_CSS] } },
              async handler(code: string, id: string) {
                const file = cleanId(id);
                const isSfc = /\.(vue|svelte)$/.test(file);
                const isFrameworkJsx = compileJsx && !file.includes('node_modules') && (/\.[jt]sx$/.test(file) || (/\.m?js$/.test(file) && looksLikeJsx(code)));
                const isAngular = framework === 'angular' && /\.ts$/.test(file) && !file.includes('node_modules');
                if (!isSfc && !isFrameworkJsx && !isAngular) return null;
                if (isAngular && ngAot) {
                    const aot = ngAot.output(file);
                    if (aot) return { code: aot.code, map: aot.map, moduleType: 'js' };
                }
                const fw = frameworkOf(file);
                const cacheable = compileCache && !isAngular && selfContained(code);
                const parts = [file, fw, code];
                // A component's own CSS (Vue, Svelte) goes to the app's stylesheet, through a module
                // the component imports, so it lands in the cascade where the component does.
                const withCss = (out: Compiled) => {
                    if (!out.css) return { code: out.code, map: null, moduleType: 'js' };
                    const cssId = `${file}?lunx-component.css`;
                    componentCss.set(cssId, out.css);
                    return { code: `${out.code}\nimport ${JSON.stringify(cssId)};`, map: null, moduleType: 'js' };
                };
                if (cacheable) {
                    const hit = await compileCache!.get(parts);
                    if (hit) return withCss(hit as Compiled);
                }
                const pool = isAngular ? null : compilePool;
                const pooled = pool && !pool.failed
                    ? await pool.compile(file, code, fw).catch((err) => {
                          if (!pool.failed) throw err; // a compile error, as on the main thread
                          return null; // the worker died: compile here instead
                      })
                    : null;
                const out: Compiled = pooled ?? (await (await getTransformer()).transform({ filePath: file, code, framework: fw as any, root, isDev: false }));
                if (cacheable) await compileCache!.set(parts, { code: out.code, ...(out.css ? { css: out.css } : {}) });
                return withCss(out);
              },
            },
        },
        ...(ngAot
            ? [{
                  // Angular's linker and build optimizations on the packages.
                  name: 'lunx:angular',
                  transform: {
                      filter: { id: /[\\/]node_modules[\\/].*\.[mc]?js(\?.*)?$/ },
                      async handler(code: string, id: string) {
                          const out = await ngAot.optimize(cleanId(id), code);
                          return out === null ? null : { code: out, map: null };
                      },
                  },
              }]
            : []),
        dynamicImportVars,
        ...(legalComments === 'linked' ? [legalCommentsPlugin()] : []),
        {
            name: 'lunx:glob-import',
            transform: {
              filter: { id: { exclude: /node_modules/ }, code: 'import.meta.glob' },
              handler(code: string, id: string) {
                if (id.includes('node_modules') || !code.includes('import.meta.glob')) return null;
                const out = transformGlobImports(code, cleanId(id), root);
                return out === null ? null : { code: out, map: null };
              },
            },
        },
        {
            // Create React App allowed JSX in `.js`; parse app sources that need it as JSX.
            name: 'lunx:jsx-in-js',
            transform: {
              filter: { id: { include: /\.m?js(\?.*)?$/, exclude: /node_modules/ } },
              async handler(code: string, id: string) {
                if (!/\.m?js$/.test(cleanId(id)) || id.includes('node_modules') || !looksLikeJsx(code)) return null;
                if (compileJsx) return null; // the framework compiler above already handled it
                return { code, moduleType: 'jsx' };
              },
            },
        },
        {
            name: 'lunx:css',
            load: {
              filter: { id: /\.(css|pcss|postcss|scss|sass|less|styl|stylus)(\?.*)?$/ },
              async handler(this: any, id: string) {
                const component = componentCss.get(id);
                if (component !== undefined) return stylesheetModule(this, id, component);
                const file = cleanId(id);
                // Not a file: a virtual stylesheet some plugin loads.
                if (!CSS_EXT.test(file) || !fs.existsSync(file)) return null;
                const raw = await fsp.readFile(file, 'utf8');
                if (/[?&]raw\b/.test(id.slice(file.length))) return { code: `export default ${JSON.stringify(raw)};`, moduleType: 'js' };
                return stylesheetModule(this, id, raw);
              },
            },
        },
        {
            name: 'lunx:assets',
            load: {
              filter: { id: /(\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|flac|aac|m4a|pdf|txt|wasm)|[?&](url|raw|init|react|component|worker|sharedworker)\b.*)$/i },
              async handler(this: any, id: string) {
                const file = cleanId(id);
                const query = id.slice(file.length);
                // `import MyWorker from './worker.js?worker'` (Vite's): a constructor for the worker, bundled as its own chunk.
                const worker = /[?&](shared)?worker\b/.exec(query);
                if (worker) return { code: await workerModule(this, file, !!worker[1], query), moduleType: 'js' };
                // `./logo.svg?react`: a component (vite-plugin-svgr, when installed, keeps it).
                const svgRuntime = /\.svg$/i.test(file) && SVG_COMPONENT_QUERY.test(query) && !app?.plugins.some((p: any) => p.name === 'vite-plugin-svgr') ? svgRuntimeFor(framework, query) : null;
                if (svgRuntime) return { code: svgComponent(await fsp.readFile(file, 'utf8'), svgRuntime), moduleType: 'js' };
                if (/\.wasm$/i.test(file) && /[?&]init\b/.test(query)) {
                    return { code: wasmInitModule(JSON.stringify(emitAsset(this, file, await fsp.readFile(file)))), moduleType: 'js' };
                }
                const wantsUrl = /[?&]url\b/.test(query);
                const wantsRaw = /[?&]raw\b/.test(query);
                if (!wantsUrl && !wantsRaw && !ASSET_EXT.test(file)) return null;
                if (CSS_EXT.test(file) && !wantsUrl) return null;
                if (wantsRaw) return { code: `export default ${JSON.stringify(await fsp.readFile(file, 'utf8'))};`, moduleType: 'js' };
                const data = await fsp.readFile(file);
                const url = !wantsUrl && data.length < inlineLimit && !/\.(svg|wasm)$/i.test(file)
                    ? `data:${mimeOf(file)};base64,${data.toString('base64')}`
                    : emitAsset(this, file, data);
                return { code: `export default ${JSON.stringify(url)};`, moduleType: 'js' };
              },
            },
        },
        {
            // A dependency file with no imports, exports or CommonJS at all
            // is a plain script (qwikloader, polyfills) that only exists for
            // its side effects; its package's `sideEffects: false` must not
            // tree-shake it away.
            name: 'lunx:script-side-effects',
            transform: {
                filter: { id: /node_modules.*\.[cm]?js$/ },
                handler(code: string, id: string) {
                    if (/\b(module|exports|require)\b/.test(code)) return null;
                    if (/\b(import|export)\b/.test(code)) {
                        // `import(` alone (lazy chunks) still leaves a script.
                        try {
                            if (parse(id, code).body.some((n: any) => /^(Import|Export)/.test(n.type))) return null;
                        } catch {
                            return null;
                        }
                    }
                    return { code, moduleSideEffects: true };
                },
            },
        },
        {
            // Babel/TypeScript-compiled CommonJS sets `__esModule`, and its
            // default import means `exports.default` — that is how webpack,
            // Babel and the lunx dev server read it. Rolldown switches to
            // Node's rule (default = module.exports) whenever the app's
            // package.json says "type": "module", which most apps do, so the
            // same import gave a different value in dev and in production.
            name: 'lunx:cjs-interop',
            renderChunk(code: string) {
                if (!code.includes('__toESM(')) return null;
                return { code: code.replace(/__toESM\((require_[\w$]+\(\)), 1\)/g, '__toESM($1)'), map: null };
            },
        },
        {
            // `new URL('./file', import.meta.url)`: emit the file (or, for a
            // worker script, a separate bundle) and point the URL at it.
            name: 'lunx:new-url',
            transform: {
              filter: { id: { exclude: /node_modules/ }, code: 'import.meta.url' },
              async handler(this: any, code: string, id: string) {
                if (!code.includes('import.meta.url') || id.includes('node_modules')) return null;
                const re = /new\s+URL\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g;
                let changed = false;
                let out = '';
                let last = 0;
                for (const m of code.matchAll(re)) {
                    const file = path.resolve(path.dirname(cleanId(id)), m[2]!);
                    if (!fs.existsSync(file)) continue;
                    let ref: string;
                    if (/\.(m?[jt]sx?)$/.test(file)) {
                        ref = this.emitFile({ type: 'chunk', id: file, name: path.basename(file).replace(/\.[^.]+$/, '') });
                    } else {
                        const data = await fsp.readFile(file);
                        const ext = path.extname(file);
                        ref = this.emitFile({ type: 'asset', name: path.basename(file), fileName: `assets/${path.basename(file, ext)}.${hash8(data)}${ext}`, source: data });
                    }
                    out += code.slice(last, m.index) + `new URL(__LUNX_FILE_URL_${ref}__, import.meta.url)`;
                    last = m.index! + m[0].length;
                    changed = true;
                }
                return changed ? { code: out + code.slice(last), map: null } : null;
              },
            },
            renderChunk(this: any, code: string, chunk: any) {
                if (!code.includes('__LUNX_FILE_URL_')) return null;
                const depth = chunk.fileName.split('/').length - 1;
                const prefix = depth === 0 ? './' : '../'.repeat(depth);
                return {
                    code: code.replace(/__LUNX_FILE_URL_([\w$-]+)__/g, (_m: string, ref: string) => JSON.stringify(prefix + this.getFileName(ref))),
                    map: null,
                };
            },
        },
        {
            name: 'lunx:css-emit',
            async generateBundle(this: any, _opts: unknown, bundle: Record<string, any>) {
                // Extracted CSS modules are empty JS, so they vanish from
                // chunk.moduleIds; walk the import graph instead. Depth-first
                // in import order is exactly the cascade order of the source.
                // Only through the modules that lead to a stylesheet: in a big
                // app most import none, and each getModuleInfo is a call into Rust.
                const leadsToCss = new Set<string>();
                const climb = [...css.ids];
                while (climb.length) {
                    const info = this.getModuleInfo(climb.pop()!);
                    for (const importer of [...(info?.importers ?? []), ...(info?.dynamicImporters ?? [])]) {
                        if (!leadsToCss.has(importer)) {
                            leadsToCss.add(importer);
                            climb.push(importer);
                        }
                    }
                }
                const order = new Set<string>();
                const visited = new Set<string>();
                const visit = (id: string) => {
                    if (visited.has(id)) return;
                    visited.add(id);
                    const file = cleanId(id);
                    if (css.has(file)) {
                        order.add(file);
                        return;
                    }
                    if (!leadsToCss.has(id)) return;
                    const info = this.getModuleInfo(id);
                    for (const dep of info?.importedIds ?? []) visit(dep);
                    for (const dep of info?.dynamicallyImportedIds ?? []) visit(dep);
                };
                const chunks = Object.values(bundle).filter((c) => c.type === 'chunk');
                chunks.sort((x, y) => Number(y.isEntry) - Number(x.isEntry));
                for (const chunk of chunks) if (chunk.facadeModuleId) visit(chunk.facadeModuleId);
                const rank = new Map([...order].map((file, i) => [file, i]));

                // CSS code splitting, as Vite: a chunk loaded only through import() brings its own
                // stylesheet, and the page's stylesheet holds only what the pages load up front.
                const split = cssCodeSplit && !federation;
                const initial = new Set<string>();
                const ownSheets = (chunk: any): string[] => {
                    const found: string[] = [];
                    for (const id of chunk.moduleIds ?? []) {
                        if (!leadsToCss.has(id)) continue;
                        for (const dep of this.getModuleInfo(id)?.importedIds ?? []) if (css.has(cleanId(dep))) found.push(cleanId(dep));
                    }
                    return found;
                };
                const byName = new Map(chunks.map((c) => [c.fileName, c]));
                const statically = (from: any[]): Set<any> => {
                    const seen = new Set<any>(from);
                    const queue = [...from];
                    while (queue.length) for (const f of queue.pop().imports ?? []) {
                        const dep = byName.get(f);
                        if (dep && !seen.has(dep)) {
                            seen.add(dep);
                            queue.push(dep);
                        }
                    }
                    return seen;
                };
                const sorted = (files: Iterable<string>) => [...new Set(files)].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
                if (split) {
                    const upFront = statically(chunks.filter((c) => c.isEntry));
                    for (const chunk of upFront) for (const file of ownSheets(chunk)) initial.add(file);
                    // Sheets no chunk claims (a page's script that imports nothing else) stay up front.
                    const claimed = new Set<string>(initial);
                    const lazy = chunks.filter((c) => !upFront.has(c) && c.isDynamicEntry);
                    for (const chunk of lazy) {
                        const sheets = sorted([...statically([chunk])].flatMap(ownSheets)).filter((f) => !initial.has(f));
                        for (const f of sheets) claimed.add(f);
                        if (!sheets.length) continue;
                        const sep = minify ? '' : '\n';
                        const text = sheets.map((f) => css.get(f)!).join(sep);
                        const fileName = `assets/${chunk.name}.${hash8(text)}.css`;
                        this.emitFile({ type: 'asset', fileName, source: text });
                        chunkCss.set(chunk.fileName, fileName);
                        // The chunk's module finishes evaluating once its stylesheet has loaded, so
                        // import() resolves with the CSS in place (no flash of unstyled content).
                        // Appended, so the chunk's source map is unaffected.
                        const href = path.posix.relative(path.posix.dirname(chunk.fileName), fileName);
                        const loader = `\nawait new Promise((r)=>{const h=new URL(${JSON.stringify(href.startsWith('.') ? href : './' + href)},import.meta.url).href;if(document.querySelector('link[rel="stylesheet"][href="'+h+'"]'))return r();const l=document.createElement("link");l.rel="stylesheet";l.href=h;l.onload=l.onerror=()=>r();document.head.appendChild(l)});\n`;
                        const mapComment = chunk.code.lastIndexOf('\n//# sourceMappingURL=');
                        chunk.code = mapComment === -1 ? chunk.code + loader : chunk.code.slice(0, mapComment) + loader + chunk.code.slice(mapComment);
                    }
                    for (const file of order) if (!claimed.has(file)) initial.add(file);
                }
                css.order = split ? sorted(initial) : [...order];
                // Emitted here, so the plugins' generateBundle sees (and may rewrite) it, as Vite's CSS.
                const all = await collectCss(this);
                if (all.trim()) {
                    cssFile = `assets/style.${hash8(all)}.css`;
                    this.emitFile({ type: 'asset', fileName: cssFile, source: all });
                }
            },
        },
    ];

    if ((build as any).manifest) {
        // Vite's `build.manifest` (.vite/manifest.json): source file → output files, for
        // server frameworks that render the page themselves (Laravel, Rails, Django…).
        plugins.push({
            name: 'lunx:manifest',
            generateBundle(this: any, _opts: unknown, bundle: Record<string, any>) {
                const chunks = Object.values(bundle).filter((o: any) => o.type === 'chunk') as any[];
                const keyOf = new Map<string, string>();
                for (const c of chunks) keyOf.set(c.fileName, c.facadeModuleId && !c.facadeModuleId.startsWith('\0') ? toPosix(path.relative(root, cleanId(c.facadeModuleId))) : `_${path.posix.basename(c.fileName)}`);
                const assetFile = (file: string) => {
                    const url = assets.get(file);
                    return url && !url.startsWith('data:') ? url.slice(url.indexOf('assets/')) : null;
                };
                const manifest: Record<string, any> = {};
                for (const c of chunks) {
                    const entry: Record<string, any> = { file: c.fileName, name: c.name };
                    if (c.facadeModuleId && !c.facadeModuleId.startsWith('\0')) entry.src = keyOf.get(c.fileName);
                    if (c.isEntry) entry.isEntry = true;
                    if (c.isDynamicEntry) entry.isDynamicEntry = true;
                    const imports = (c.imports ?? []).map((f: string) => keyOf.get(f)).filter(Boolean);
                    const dynamicImports = (c.dynamicImports ?? []).map((f: string) => keyOf.get(f)).filter(Boolean);
                    if (imports.length) entry.imports = imports;
                    if (dynamicImports.length) entry.dynamicImports = dynamicImports;
                    const sheets = [...(c.isEntry && cssFile ? [cssFile] : []), ...(chunkCss.has(c.fileName) ? [chunkCss.get(c.fileName)!] : [])];
                    if (sheets.length) entry.css = sheets;
                    const used = [...new Set((c.moduleIds ?? []).map((id: string) => assetFile(cleanId(id))).filter(Boolean))];
                    if (used.length) entry.assets = used;
                    manifest[keyOf.get(c.fileName)!] = entry;
                }
                for (const [file] of assets) {
                    const out = assetFile(file);
                    const key = toPosix(path.relative(root, file));
                    if (out && !manifest[key]) manifest[key] = { file: out, src: key };
                }
                const where = typeof (build as any).manifest === 'string' ? (build as any).manifest : '.vite/manifest.json';
                this.emitFile({ type: 'asset', fileName: where, source: JSON.stringify(manifest, null, 2) + '\n' });
            },
        });
    }

    if (vp) {
        plugins.push(...vp.forRolldown(app!, [...app!.normal, ...app!.post], pluginCss));
        // Vite's asset placeholders in plugin output (vite-imagetools' `__VITE_ASSET__<ref>__`).
        plugins.push({
            name: 'lunx:vite-asset-urls',
            renderChunk(this: any, code: string, chunk: any) {
                if (!code.includes('__VITE_ASSET__')) return null;
                const dir = path.posix.dirname(chunk.fileName);
                return {
                    code: code.replace(/__VITE_ASSET__([\w$]+)__(?:\$_(.*?)__)?/g, (_m: string, ref: string, postfix = '') => {
                        const fileName = this.getFileName(ref) + postfix;
                        // A relative base: resolved against the chunk at run time.
                        return base === './' ? `"+new URL(${JSON.stringify(path.posix.relative(dir, fileName))}, import.meta.url).href+"` : base + fileName;
                    }),
                    map: null,
                };
            },
        });
        // As Vite: a plugin's virtual module imports packages from the project root.
        const real = new Map<string, boolean>();
        const rootImporter = path.join(root, 'index.html');
        plugins.push({
            name: 'lunx:virtual-importer',
            resolveId: {
                filter: { id: /^[\w@]/ },
                handler(this: any, source: string, importer: string | undefined, opts: any) {
                    if (!importer || source.includes(':')) return null;
                    const file = cleanId(importer);
                    let exists = real.get(file);
                    if (exists === undefined) real.set(file, (exists = !file.startsWith('\0') && path.isAbsolute(file) && fs.existsSync(file)));
                    return exists ? null : this.resolve(source, rootImporter, { ...opts, skipSelf: true });
                },
            },
        });
    }
    if (federation) plugins.push(federationEnginePlugin(federation, root, appEntries));
    // Rolldown has the module graph and renders and minifies in Rust from here: start the
    // JavaScript work the build needs next while the main thread would otherwise wait.
    plugins.push({
        name: 'lunx:engine-busy',
        buildEnd: () => {
            if (build.compress !== false) void loadZlib();
            options.onEngineBusy?.();
        },
    });

    // ── Rolldown ─────────────────────────────────────────────────────────────
    const envDefines: Record<string, string> = { ...((config as any).__envDefines ?? {}) };
    const metaEnv: Record<string, unknown> = {
        ...(safeJson(envDefines['import.meta.env'] ?? '{}') as Record<string, unknown>),
        MODE: config.mode, PROD: config.mode === 'production', DEV: config.mode !== 'production', SSR: false, BASE_URL: base,
    };
    delete envDefines['import.meta.env'];
    const define: Record<string, string> = {
        ...envDefines,
        ...(ngAot?.defines ?? {}),
        'process.env.NODE_ENV': JSON.stringify(config.mode === 'production' ? 'production' : config.mode),
        'import.meta.env': JSON.stringify(metaEnv),
        ...Object.fromEntries(Object.entries(metaEnv).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])),
        ...((config as any).define ?? {}),
        // What the plugins' `config` hooks added.
        ...Object.fromEntries(Object.entries(app?.config.define ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
    };

    const tsconfig = ['tsconfig.json', 'jsconfig.json'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
    const jsxImportSource = framework === 'preact' ? 'preact' : undefined;

    await emptyDir(outDir, root);

    const manualChunks = build.manualChunks;
    const output: OutputItem[] = Object.keys(input).length === 0 ? [] : await getBundler().bundle({
        input,
        cwd: root,
        platform: 'browser',
        plugins,
        tsconfig,
        alias: alias ?? undefined,
        extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.vue', '.svelte', '.json'],
        // Never `development`: dev-only builds of React/Vue are 3–10× larger.
        conditions: ['browser', 'import', 'module', config.mode === 'production' ? 'production' : 'development', 'default'],
        define,
        ...(targets.js ? { target: targets.js } : {}),
        jsx: jsxImportSource ? { runtime: 'automatic', importSource: jsxImportSource } : undefined,
        // Normal in app code; not worth a warning on every build.
        onWarning: (w) => !['EVAL', 'CIRCULAR_DEPENDENCY', 'MIXED_EXPORT'].includes(w.code ?? ''),
    }, {
        dir: outDir,
        format: 'es',
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
        minify,
        legalComments: legalComments === 'inline',
        sourcemap: sourcemapOption(build.sourcemap),
        chunkGroups: manualChunks
            ? Object.entries(manualChunks).map(([name, pkgs]) => ({
                  name,
                  test: new RegExp(`[\\\\/]node_modules[\\\\/](${pkgs.map(escapeRe).join('|')})[\\\\/]`),
              }))
            : undefined,
    }, true).finally(() => Promise.all([compilePool?.close(), compileCache?.flush(), ngAot?.flush()]));

    // ── CSS ──────────────────────────────────────────────────────────────────
    // Emitted in the bundle (lunx:css-emit); a page with only stylesheets has no bundle.
    if (Object.keys(input).length === 0) {
        const allCss = await collectCss({ emitFile: (f: any) => emittedAssets.push({ fileName: f.fileName, type: 'asset', source: f.source }) });
        if (allCss.trim()) {
            cssFile = `assets/style.${hash8(allCss)}.css`;
            emittedAssets.push({ fileName: cssFile, type: 'asset', source: allCss });
        }
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
            ...(pwa ? pwaHeadTags(pwa, base) : []),
        ];
        if (head.length) {
            const tags = head.map((t) => `    ${t}\n`).join('');
            page = /<\/head>/i.test(page) ? page.replace(/<\/head>/i, `${tags}  </head>`) : tags + page;
        }
        if (vp) {
            const entryChunk = [...html.scripts.values()].map((name) => chunkByName.get(name)).find(Boolean);
            page = await vp.transformIndexHtml(app!, 'post', page, {
                path: '/' + toPosix(path.relative(root, html.file)),
                filename: html.file,
                bundle: Object.fromEntries(output.map((o) => [o.fileName, o])),
                chunk: entryChunk,
            });
        }
        const target = path.join(outDir, path.relative(root, html.file));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, page);
        emittedAssets.push({ fileName: toPosix(path.relative(outDir, target)), type: 'asset', source: page });
    }

    for (const file of pwa ? pwaFiles(pwa, base) : []) {
        await fsp.writeFile(path.join(outDir, file.fileName), file.source);
        emittedAssets.push({ ...file, type: 'asset' });
    }

    // ── Module federation container ──────────────────────────────────────────
    if (federation) {
        const entryFiles = new Map<string, string>();
        for (const item of output) if (item.type === 'chunk' && item.isEntry) entryFiles.set(item.name, item.fileName);
        const remoteEntry = await writeRemoteEntry(federation, root, outDir, entryFiles, cssFile ? [cssFile] : []);
        if (remoteEntry) emittedAssets.push({ fileName: remoteEntry.fileName, type: 'asset', source: remoteEntry.code });
        // Type hints for hosts (lunx, webpack, Rspack): @mf-types.zip next to remoteEntry.js.
        if (remoteEntry && dtsSides(federation).generate) {
            const modules = output.flatMap((item) => (item.type === 'chunk' ? item.moduleIds : []));
            const types = await generateRemoteTypes(root, outDir, federation, modules).catch((err) => {
                log.warn(`[lunx mf] no type hints for the exposed modules: ${err?.message ?? err}`);
                return null;
            });
            if (types) {
                const manifestFile = path.join(outDir, 'mf-manifest.json');
                const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
                manifest.metaData = { ...manifest.metaData, types: { path: '', name: '', zip: types[0], api: types[1] } };
                await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
            }
        }
        if (remoteTypes) await remoteTypes;
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
    let finishCompression: (() => Promise<void>) | undefined;
    if (build.compress !== false) {
        // Brotli 6: within ~1% of quality 9's size at a third of the time (36 ms vs 11 ms for a 220 kB bundle).
        const quality = typeof build.compress === 'object' ? build.compress.brotliQuality ?? 6 : 6;
        const compressible = artifacts.filter((a) => /\.(js|mjs|css|html|svg|json)$/.test(a.fileName));
        const isHtml = (a: BuildArtifact) => a.fileName.endsWith('.html');
        const rest = Promise.all(
            compressible
                .filter((a) => !(options.deferCompression && isHtml(a)))
                .map((a) => precompress(path.join(outDir, a.fileName), Buffer.from(a.source), quality)),
        );
        if (options.deferCompression) {
            rest.catch(() => {}); // observed by finishCompression
            finishCompression = async () => {
                await Promise.all([
                    rest,
                    ...compressible.filter(isHtml).map(async (a) => {
                        const file = path.join(outDir, a.fileName);
                        await precompress(file, await fsp.readFile(file), quality);
                    }),
                ]);
            };
        } else {
            await rest;
        }
    }

    const modules = new Set<string>();
    for (const o of output) if (o.type === 'chunk') for (const id of o.moduleIds as string[]) if (path.isAbsolute(cleanId(id))) modules.add(cleanId(id));

    // Plugins' writeBundle / closeBundle (a service worker over the finished app…), then lunx's own service worker.
    const afterWrite = vp || pwa
        ? async () => {
              if (vp) await vp.runAfterWrite(app!, outDir, artifacts);
              if (pwa) writeServiceWorker(outDir, pwa);
          }
        : undefined;
    if (afterWrite && !options.deferAfterWrite) await afterWrite();

    return {
        success: true, engine: getBundler().name, durationMs: performance.now() - started, artifacts, modules: [...modules], finishCompression,
        afterWrite: options.deferAfterWrite ? afterWrite : undefined,
    };
}

/**
 * Vite plugins from vite.config (framework plugins already replaced by lunx)
 * and lunx.config, resolved as Vite would: `apply`, `enforce`, `config`,
 * `configResolved`. Null when there are none: then nothing of this loads.
 */
async function resolveVitePlugins(config: BuildConfig, root: string, outDir: string): Promise<AppPlugins | null> {
    const list = [
        ...((config as any).__vitePlugins ?? []),
        ...(config.plugins ?? []).filter((p: any) => p && typeof p === 'object'),
    ];
    if (!list.length) return null;
    const vite = (config as any).__viteConfig ?? {};
    const { resolveAppPlugins } = await import('../plugin-host/app-plugins.js');
    return resolveAppPlugins(root, {
        ...vite,
        // Only a base the user set: plugins' `config` hooks may set one otherwise (`./` for Electron).
        ...((config as any).base ?? vite.base ? { base: (config as any).base ?? vite.base } : {}),
        publicDir: (config as any).publicDir ?? vite.publicDir,
        build: { ...vite.build, outDir: path.relative(root, outDir) || '.' },
    }, list, 'build', config.mode ?? 'production');
}

// ── CSS processing ───────────────────────────────────────────────────────────

class CssCollector {
    private sheets = new Map<string, string>();
    order: string[] = [];
    /** The module ids the stylesheets were collected under. */
    ids = new Set<string>();
    emitAsset!: (ctx: any, file: string, data: Buffer) => string;

    constructor(private root: string, private base: string, private minify: boolean, private inlineLimit: number, private targets: Record<string, number> | null = null) {}

    has(file: string) { return this.sheets.has(file); }
    get(file: string) { return this.sheets.get(file); }
    add(file: string, code: string, id?: string) {
        this.sheets.set(file, code);
        if (id) this.ids.add(id);
    }

    process(ctx: any, file: string, source: string, modules: boolean): Promise<CompiledCss> {
        return compileCss({
            root: this.root,
            file,
            source,
            modules,
            minify: this.minify,
            targets: this.targets,
            resolveUrl: (from, url) => {
                // A relative base: url()s resolve against the CSS file, which is in assets/.
                const relative = this.base === './';
                const clean = url.split(/[?#]/)[0]!;
                if (clean.startsWith('/') && fs.existsSync(path.join(this.root, 'public', clean))) return (relative ? '../' : this.base) + clean.slice(1);
                const target = resolveCssFile(this.root, from, url);
                if (!target) return url;
                const data = fs.readFileSync(target);
                if (data.length < this.inlineLimit && !/\.svg$/i.test(target)) return `data:${mimeOf(target)};base64,${data.toString('base64')}`;
                const emitted = this.emitAsset(ctx, target, data);
                return (relative ? emitted.replace(/^\.\/assets\//, './') : emitted) + url.slice(clean.length);
            },
        });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** What compiled output depends on besides the source: compiler versions and their config files. */
function compilerSalt(root: string, framework: string, mode: string): string {
    const parts = [framework, mode];
    // The compiler code itself: a fix to it must not be served stale results.
    try {
        parts.push(crypto.createHash('sha256').update(fs.readFileSync(new URL('../core/universal-transformer.js', import.meta.url))).digest('hex'));
    } catch {
        parts.push(String(Date.now())); // unknown compiler: never reuse
    }
    const req = (() => {
        try {
            return createRequire(path.join(root, 'package.json'));
        } catch {
            return null;
        }
    })();
    for (const pkg of ['vue', '@vue/compiler-sfc', 'svelte', 'solid-js', 'babel-preset-solid', 'preact', '@builder.io/qwik', 'mithril']) {
        try {
            parts.push(`${pkg}@${JSON.parse(fs.readFileSync(req!.resolve(`${pkg}/package.json`), 'utf8')).version}`);
        } catch {
            // not installed
        }
    }
    for (const f of ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts', 'tsconfig.json', 'babel.config.js', '.babelrc']) {
        try {
            parts.push(f, fs.readFileSync(path.join(root, f), 'utf8'));
        } catch {
            // absent
        }
    }
    return parts.join('\0');
}

function ensureSlashes(base: string): string {
    // Relative: assets resolve against the page (a page opened from disk, `file://`).
    if (base === './' || base === '.' || base === '') return './';
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

function toAliasList(alias: unknown): Array<{ find: string; replacement: string }> {
    if (!alias) return [];
    if (Array.isArray(alias)) return alias.filter((a) => typeof a?.find === 'string' && typeof a?.replacement === 'string');
    return Object.entries(alias as Record<string, string>).map(([find, replacement]) => ({ find, replacement }));
}

function normalizeAlias(alias: unknown, root: string): Record<string, string> | null {
    if (!alias || (Array.isArray(alias) && alias.length === 0)) return null;
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

/**
 * `build.legalComments: 'linked'` (the default): the `@license` / `/*!` notices of
 * the packages in each chunk go to `<chunk>.LICENSE.txt` beside it, linked from the
 * end of the chunk, as Rsbuild and webpack do, instead of in the shipped code.
 */
function legalCommentsPlugin(): any {
    const notices = new Map<string, string[]>();
    const LEGAL = /\/\*\*?![\s\S]*?\*\/|\/\*[\s\S]*?(?:@license|@preserve|@copyright)[\s\S]*?\*\//g;
    return {
        name: 'lunx:legal-comments',
        transform: {
            filter: { id: /node_modules/, code: { include: [/@license|@preserve|@copyright|\/\*!/] } },
            handler(code: string, id: string) {
                const found = code.match(LEGAL);
                if (found) notices.set(id, [...new Set(found)]);
                return null;
            },
        },
        generateBundle(this: any, _opts: unknown, bundle: Record<string, any>) {
            for (const chunk of Object.values(bundle) as any[]) {
                if (chunk.type !== 'chunk') continue;
                const text = [...new Set((chunk.moduleIds ?? []).flatMap((id: string) => notices.get(id) ?? []))];
                if (!text.length) continue;
                const fileName = `${chunk.fileName}.LICENSE.txt`;
                this.emitFile({ type: 'asset', fileName, source: text.join('\n\n') + '\n' });
                const banner = `\n/*! Licenses: ${path.posix.basename(fileName)} */`;
                const map = chunk.code.lastIndexOf('\n//# sourceMappingURL=');
                chunk.code = map === -1 ? chunk.code + banner : chunk.code.slice(0, map) + banner + chunk.code.slice(map);
            }
        },
    };
}
