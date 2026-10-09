/**
 * One CSS compiler for dev and build: the project's PostCSS config (Tailwind,
 * autoprefixer, …) when it has one, then LightningCSS for nesting, vendor
 * prefixes, CSS Modules, `@import` inlining and `url()` rewriting.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { lightningcss } from '../lib/lightningcss.js';

export interface CompiledCss {
    code: string;
    /** CSS Modules: local class name → generated class names */
    exports?: Record<string, string>;
    /** Every file read to produce this sheet (for watching). */
    dependencies: string[];
}

export interface CompileCssOptions {
    root: string;
    file: string;
    source: string;
    modules: boolean;
    minify: boolean;
    /** Map a `url()` found in `from` to what the output should reference. */
    resolveUrl: (from: string, url: string) => string;
}

type PostcssRunner = (css: string, from: string) => Promise<{ css: string; dependencies: string[] }>;
const postcssByRoot = new Map<string, Promise<PostcssRunner | null>>();

export const CSS_LANGS = /\.(css|pcss|postcss|scss|sass|less|styl|stylus)$/i;
export const isCssModule = (file: string) => /\.module\.(css|pcss|postcss|scss|sass|less|styl|stylus)$/i.test(file);

/** Sass / Less / Stylus, loaded from the project when it uses them. */
async function preprocess(root: string, file: string, source: string): Promise<{ css: string; dependencies: string[] }> {
    const ext = path.extname(file).toLowerCase();
    const req = createRequire(path.join(root, 'package.json'));
    const load = async (pkg: string) => {
        try {
            const mod = await import(pathToFileURL(req.resolve(pkg)).href);
            return mod.default ?? mod;
        } catch {
            throw new Error(`${path.basename(file)} needs ${pkg}: npm i -D ${pkg}`);
        }
    };
    if (ext === '.scss' || ext === '.sass') {
        let sass: any;
        try {
            sass = await load('sass-embedded');
        } catch {
            sass = await load('sass');
        }
        const result = await sass.compileStringAsync(source, {
            syntax: ext === '.sass' ? 'indented' : 'scss',
            url: pathToFileURL(file),
            loadPaths: [path.dirname(file), path.join(root, 'node_modules')],
        });
        return { css: result.css, dependencies: (result.loadedUrls ?? []).filter((u: URL) => u.protocol === 'file:').map((u: URL) => u.pathname) };
    }
    if (ext === '.less') {
        const less = await load('less');
        const result = await less.render(source, { filename: file, paths: [path.dirname(file), path.join(root, 'node_modules')] });
        return { css: result.css, dependencies: result.imports ?? [] };
    }
    if (ext === '.styl' || ext === '.stylus') {
        const stylus = await load('stylus');
        const css = await new Promise<string>((resolve, reject) =>
            stylus(source).set('filename', file).render((err: Error | null, out: string) => (err ? reject(err) : resolve(out))),
        );
        return { css, dependencies: [] };
    }
    return { css: source, dependencies: [] };
}

export async function compileCss(opts: CompileCssOptions): Promise<CompiledCss> {
    const dependencies = [opts.file];
    let runner = postcssByRoot.get(opts.root);
    if (!runner) {
        runner = loadPostcss(opts.root);
        postcssByRoot.set(opts.root, runner);
    }
    const post = await runner;
    const pre = await preprocess(opts.root, opts.file, opts.source);
    dependencies.push(...pre.dependencies);
    let input = pre.css;
    if (post) {
        const result = await post(input, opts.file);
        input = result.css;
        dependencies.push(...result.dependencies);
    }

    const { transform } = lightningcss();
    const result = transform({
        filename: opts.file,
        code: Buffer.from(input),
        minify: opts.minify,
        cssModules: opts.modules ? { pattern: '[local]_[hash]' } : false,
        analyzeDependencies: true,
        errorRecovery: true,
        drafts: { customMedia: true },
    } as any);

    let code = result.code.toString();
    const deps = (result.dependencies ?? []) as any[];
    for (const dep of deps) {
        if (dep.type === 'url') code = code.split(dep.placeholder).join(opts.resolveUrl(opts.file, dep.url));
    }

    // Inline local `@import`s in source order; keep remote ones.
    let imported = '';
    for (const dep of deps) {
        if (dep.type !== 'import') continue;
        const target = resolveCssFile(opts.root, opts.file, dep.url);
        if (!target) continue;
        const inner = await compileCss({ ...opts, file: target, source: await fsp.readFile(target, 'utf8'), modules: false });
        imported += inner.code + '\n';
        dependencies.push(...inner.dependencies);
    }
    if (imported) {
        code = imported + code.replace(/@import\s+[^;]+;/g, (stmt) => (/https?:\/\//.test(stmt) ? stmt : ''));
    }

    const exports = result.exports
        ? Object.fromEntries(
              Object.entries(result.exports as Record<string, any>).map(([k, v]) => [
                  k,
                  [v.name, ...(v.composes ?? []).map((c: any) => c.name)].join(' '),
              ]),
          )
        : undefined;
    return { code, exports, dependencies };
}

/** Resolve a CSS `url()`/`@import` target to a file on disk. */
export function resolveCssFile(root: string, from: string, url: string): string | null {
    if (/^(data:|https?:|\/\/|#)/.test(url)) return null;
    const clean = url.split(/[?#]/)[0]!;
    const candidates = clean.startsWith('/')
        ? [path.join(root, clean), path.join(root, 'public', clean)]
        : [path.resolve(path.dirname(from), clean)];
    if (!clean.startsWith('.') && !clean.startsWith('/')) {
        const req = createRequire(from);
        for (const spec of [clean, clean.replace(/^~/, '')]) {
            try {
                candidates.push(req.resolve(spec));
            } catch {
                /* not a package path */
            }
        }
    }
    return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** Load the project's PostCSS config, if any. */
async function loadPostcss(root: string): Promise<PostcssRunner | null> {
    const name = ['postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'postcss.config.ts', '.postcssrc.json', '.postcssrc']
        .find((f) => fs.existsSync(path.join(root, f)));
    if (!name) return null;
    const req = createRequire(path.join(root, 'package.json'));
    let postcss: any;
    try {
        postcss = (await import(pathToFileURL(req.resolve('postcss')).href)).default;
    } catch {
        console.warn(`[lunx] ${name} found but postcss is not installed — run: npm i -D postcss`);
        return null;
    }
    const file = path.join(root, name);
    let loaded: any;
    if (name.startsWith('.postcssrc')) {
        loaded = JSON.parse(await fsp.readFile(file, 'utf8'));
    } else if (name.endsWith('.ts')) {
        const { importBundled } = await import('../lib/load-module.js');
        loaded = await importBundled(file, { root });
    } else {
        loaded = (await import(pathToFileURL(file).href)).default;
    }
    if (typeof loaded === 'function') loaded = loaded({ env: process.env.NODE_ENV ?? 'development' });
    const spec = loaded?.plugins ?? [];
    const plugins: any[] = [];
    if (Array.isArray(spec)) plugins.push(...spec.filter(Boolean));
    else {
        for (const [pluginName, options] of Object.entries(spec)) {
            if (options === false) continue;
            const mod = await import(pathToFileURL(req.resolve(pluginName)).href);
            const plugin = mod.default ?? mod;
            plugins.push(typeof plugin === 'function' ? plugin(options === true || options == null || (typeof options === 'object' && !Object.keys(options as object).length) ? undefined : options) : plugin);
        }
    }
    const processor = postcss(plugins);
    return async (css, from) => {
        const result = await processor.process(css, { from, map: false });
        const dependencies = (result.messages as any[])
            .filter((m) => m.type === 'dependency' && m.file)
            .map((m) => m.file as string);
        return { css: result.css, dependencies };
    };
}
