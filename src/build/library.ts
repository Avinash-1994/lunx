/**
 * Library mode: builds a package for npm instead of an app (Vite's
 * `build.lib`, tsup, unbuild). One Rolldown build per format, from one or
 * more entries:
 *
 *   - dependencies, peerDependencies, optionalDependencies and Node built-ins
 *     stay imports; everything else (devDependencies, your sources) is bundled
 *   - ES and CommonJS outputs share chunks between entries; UMD and IIFE are
 *     single-file globals for <script> use
 *   - Vue / Svelte single-file components and Solid / Preact JSX compile with
 *     the same compilers as app builds; CSS (Sass, Less, Stylus, PostCSS, CSS
 *     modules) is extracted into one stylesheet; assets are inlined
 *   - `.d.ts` files come from Oxc's isolated declarations, falling back to
 *     `tsc --emitDeclarationOnly` when a source needs type inference
 *   - package.json `main` / `module` / `types` / `exports` are checked against
 *     the files the build wrote
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { getBundler, type OutputItem } from '../engines/index.js';
import { requireEsm } from '../engines/require-esm.js';
import { CSS_LANGS, compileCss, isCssModule, resolveCssFile } from './css.js';

export type LibraryFormat = 'es' | 'cjs' | 'umd' | 'iife';

export interface LibraryOptions {
    /** Entry file(s): a path, a list, or `{ name: path }`. */
    entry: string | string[] | Record<string, string>;
    /** Global variable name for UMD / IIFE. */
    name?: string;
    /** Default: ['es', 'cjs'], or ['es', 'umd'] when `name` is set. */
    formats?: LibraryFormat[];
    /** Output file name (without extension), or a function of format and entry name. */
    fileName?: string | ((format: LibraryFormat, entryName: string) => string);
    /** More imports to keep external, beyond dependencies and peerDependencies. */
    external?: Array<string | RegExp>;
    /** Dependencies to bundle anyway. */
    noExternal?: Array<string | RegExp>;
    /** Emit `.d.ts` files. Default: when the project has a tsconfig.json. */
    dts?: boolean;
    /** Name of the extracted stylesheet (default: `style.css`). */
    cssFileName?: string;
    minify?: boolean;
    sourcemap?: boolean;
    outDir?: string;
    /** Global names of external imports, for UMD / IIFE (`{ react: 'React' }`). */
    globals?: Record<string, string>;
    /**
     * Runtime the output targets. Default: Node for CommonJS, browsers otherwise.
     * 'edge' (workers): bundles every dependency, as there is no node_modules there.
     */
    platform?: 'browser' | 'node' | 'edge';
    /** Check package.json fields against the output (default: true; app server builds turn it off). */
    checkPackage?: boolean;
}

export interface LibraryResult {
    files: Array<{ file: string; format: LibraryFormat | 'css' | 'dts'; size: number }>;
    durationMs: number;
    /** package.json fields pointing at files that do not exist after the build. */
    problems: string[];
    /** Source files bundled. */
    modules: string[];
}

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|txt)$/i;
const SOURCE_RE = /\.(m|c)?tsx?$/;

/** The globals well-known packages set when loaded with <script>. */
const DEFAULT_GLOBALS: Record<string, string> = {
    react: 'React', 'react-dom': 'ReactDOM', 'react-dom/client': 'ReactDOM', vue: 'Vue', preact: 'preact',
    'preact/hooks': 'preactHooks', jquery: 'jQuery', lodash: '_', 'lodash-es': '_', 'solid-js': 'Solid', 'solid-js/web': 'SolidWeb',
};

function readJson(file: string): any {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function entriesOf(entry: LibraryOptions['entry'], root: string): Record<string, string> {
    const list: Array<[string, string]> = typeof entry === 'string'
        ? [[path.basename(entry).replace(/\.[^.]+$/, ''), entry]]
        : Array.isArray(entry)
            ? entry.map((e) => [path.basename(e).replace(/\.[^.]+$/, ''), e])
            : Object.entries(entry);
    const out: Record<string, string> = {};
    for (const [name, file] of list) {
        const abs = path.resolve(root, file);
        if (!fs.existsSync(abs)) throw new Error(`[lunx lib] entry not found: ${file}`);
        out[name] = abs;
    }
    return out;
}

/** Vite's naming: `.js` / `.cjs` follow the package's "type". */
function extensionFor(format: LibraryFormat, isModulePackage: boolean): string {
    if (format === 'es') return isModulePackage ? '.js' : '.mjs';
    if (format === 'cjs') return isModulePackage ? '.cjs' : '.js';
    if (format === 'umd') return isModulePackage ? '.umd.cjs' : '.umd.js';
    return '.iife.js';
}

function mime(file: string): string {
    const ext = path.extname(file).slice(1).toLowerCase();
    return ({ svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm', txt: 'text/plain' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

export async function buildLibrary(root: string, options: LibraryOptions, framework?: string): Promise<LibraryResult> {
    const started = performance.now();
    const pkg = readJson(path.join(root, 'package.json')) ?? {};
    const isModulePackage = pkg.type === 'module';
    const entries = entriesOf(options.entry, root);
    const entryNames = Object.keys(entries);
    const formats: LibraryFormat[] = options.formats ?? (options.name ? ['es', 'umd'] : ['es', 'cjs']);
    const outDir = path.resolve(root, options.outDir ?? 'dist');
    const cssFileName = options.cssFileName ?? 'style.css';

    for (const f of formats) {
        if ((f === 'umd' || f === 'iife') && entryNames.length > 1) throw new Error(`[lunx lib] the ${f} format needs a single entry (got ${entryNames.length})`);
        if ((f === 'umd' || f === 'iife') && !options.name) throw new Error(`[lunx lib] the ${f} format needs \`name\`, the global variable to assign`);
    }

    // Externals: what the package declares it depends on, its subpaths, and Node built-ins.
    const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];
    const builtins = new Set(builtinModules);
    const matches = (list: Array<string | RegExp> | undefined, id: string) =>
        (list ?? []).some((p) => (typeof p === 'string' ? id === p || id.startsWith(p + '/') : p.test(id)));
    const isExternal = (id: string, single = false): boolean => {
        if (id.startsWith('\0') || id.startsWith('.') || path.isAbsolute(id)) return false;
        if (matches(options.noExternal, id)) return false;
        // A <script> build has no module loader for `react/jsx-runtime`: bundle the (tiny) runtime.
        if (single && /^(react|preact|vue|solid-js)\/jsx(-dev)?-runtime$/.test(id)) return false;
        if (id.startsWith('node:') || builtins.has(id) || builtins.has(id.split('/')[0]!)) return true;
        if (options.platform === 'edge') return matches(options.external, id);
        return declared.some((d) => id === d || id.startsWith(d + '/')) || matches(options.external, id);
    };

    // Same compilers as app builds, loaded only when a source needs them.
    let transformer: Promise<any> | null = null;
    const getTransformer = () => (transformer ??= import('../core/universal-transformer.js').then((m) => new m.UniversalTransformer(root, { cache: false })));
    const compileJsx = framework === 'solid' || framework === 'preact' || framework === 'qwik';

    const sheets = new Map<string, string>();
    const sheetOrder: string[] = [];
    const minify = options.minify;

    const plugins: any[] = [
        {
            name: 'lunx-lib:framework',
            transform: {
                filter: { id: { include: compileJsx ? /\.(vue|svelte|[jt]sx)(\?.*)?$/ : /\.(vue|svelte)(\?.*)?$/, exclude: /node_modules/ } },
                async handler(code: string, id: string) {
                    const file = id.split('?')[0]!;
                    const fw = file.endsWith('.vue') ? 'vue' : file.endsWith('.svelte') ? 'svelte' : framework;
                    const out = await (await getTransformer()).transform({ filePath: file, code, framework: fw, root, isDev: false });
                    // A published package must not carry the author's file paths.
                    return { code: out.code.replace(/^.*\.__file\s*=\s*["'][^"']*["'];?\s*$/m, ''), map: null, moduleType: 'js' };
                },
            },
        },
        {
            name: 'lunx-lib:css',
            load: {
                filter: { id: /\.(css|pcss|postcss|scss|sass|less|styl|stylus)(\?.*)?$/ },
                async handler(id: string) {
                    const file = id.split('?')[0]!;
                    if (!CSS_LANGS.test(file)) return null;
                    const query = id.slice(file.length);
                    const raw = await fsp.readFile(file, 'utf8');
                    if (/[?&]raw\b/.test(query)) return { code: `export default ${JSON.stringify(raw)};`, moduleType: 'js' };
                    const result = await compileCss({
                        root, file, source: raw, modules: isCssModule(file), minify: !!minify,
                        resolveUrl: (from, url) => {
                            const target = resolveCssFile(root, from, url);
                            if (!target) return url;
                            return `data:${mime(target)};base64,${fs.readFileSync(target).toString('base64')}`;
                        },
                    });
                    if (/[?&]inline\b/.test(query)) return { code: `export default ${JSON.stringify(result.code)};`, moduleType: 'js' };
                    if (!sheets.has(file)) sheetOrder.push(file);
                    sheets.set(file, result.code);
                    return { code: result.exports ? `export default ${JSON.stringify(result.exports)};` : 'export {};', moduleType: 'js', moduleSideEffects: false };
                },
            },
        },
        {
            // A library cannot assume where its assets will be served from: inline them.
            name: 'lunx-lib:assets',
            load: {
                filter: { id: /(\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|wasm|txt)|[?&](url|raw)\b.*)$/i },
                async handler(id: string) {
                    const file = id.split('?')[0]!;
                    const query = id.slice(file.length);
                    if (/[?&]raw\b/.test(query)) return { code: `export default ${JSON.stringify(await fsp.readFile(file, 'utf8'))};`, moduleType: 'js' };
                    if (!ASSET_RE.test(file) && !/[?&]url\b/.test(query)) return null;
                    if (CSS_LANGS.test(file)) return null;
                    const data = await fsp.readFile(file);
                    return { code: `export default ${JSON.stringify(`data:${mime(file)};base64,${data.toString('base64')}`)};`, moduleType: 'js' };
                },
            },
        },
    ];

    // Emptied first, so never the project itself or a directory above it.
    const rel = path.relative(outDir, root);
    if (outDir === root || !rel.startsWith('..')) throw new Error(`[lunx lib] outDir ${outDir} contains the project; choose a subdirectory such as dist`);
    await fsp.rm(outDir, { recursive: true, force: true });
    const files: LibraryResult['files'] = [];
    const sourceModules = new Set<string>();
    for (const format of formats) {
        const ext = extensionFor(format, isModulePackage);
        const name = (entryName: string) =>
            typeof options.fileName === 'function' ? options.fileName(format, entryName) : options.fileName && entryNames.length === 1 ? options.fileName : entryName;
        const single = format === 'umd' || format === 'iife';
        const output: OutputItem[] = await getBundler().bundle({
            input: entries,
            cwd: root,
            platform: options.platform === 'node' ? 'node' : options.platform === 'edge' ? 'browser' : format === 'cjs' ? 'node' : 'browser',
            plugins,
            external: (id: string) => isExternal(id, single),
            quiet: true,
            define: { 'import.meta.env.MODE': JSON.stringify('production'), 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false', 'import.meta.env.SSR': 'false' },
            extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.vue', '.svelte', '.json'],
            conditions: options.platform === 'edge' ? ['workerd', 'worker', 'edge-light', 'import', 'module', 'default'] : options.platform === 'node' ? ['node', 'import', 'module', 'default'] : ['import', 'module', 'default'],
            jsx: framework === 'preact' ? { runtime: 'automatic', importSource: 'preact' } : undefined,
        }, {
            dir: outDir,
            format,
            name: options.name,
            globals: single ? { ...DEFAULT_GLOBALS, ...options.globals } : undefined,
            entryFileNames: (chunk: any) => `${name(chunk.name)}${ext}`,
            chunkFileNames: `chunks/[name]-[hash]${ext}`,
            minify: options.minify ?? single,
            sourcemap: options.sourcemap ?? false,
            inlineDynamicImports: single,
            exports: 'named',
        }, true);
        for (const item of output) {
            if (item.type !== 'chunk') continue;
            for (const id of item.moduleIds) if (path.isAbsolute(id) && !id.includes('node_modules')) sourceModules.add(id.split('?')[0]!);
            if (item.isEntry || format === 'es' || format === 'cjs') files.push({ file: item.fileName, format, size: Buffer.byteLength(item.code) });
        }
    }

    if (sheetOrder.length) {
        const css = sheetOrder.map((f) => sheets.get(f)).join('\n');
        await fsp.writeFile(path.join(outDir, cssFileName), css);
        files.push({ file: cssFileName, format: 'css', size: Buffer.byteLength(css) });
    }

    const tsconfig = path.join(root, 'tsconfig.json');
    if (options.dts ?? fs.existsSync(tsconfig)) {
        const written = await emitDeclarations(root, outDir, entries, [...sourceModules]);
        const outputName = (entryName: string) =>
            typeof options.fileName === 'function' ? options.fileName('es', entryName) : options.fileName && entryNames.length === 1 ? options.fileName : entryName;
        written.push(...(await entryDeclarations(outDir, entries, written, outputName)));
        for (const f of written) files.push({ file: f, format: 'dts', size: fs.statSync(path.join(outDir, f)).size });
    }

    return { files, durationMs: performance.now() - started, problems: options.checkPackage === false ? [] : checkPackageJson(root, pkg), modules: [...sourceModules] };
}

/**
 * `.d.ts` for every TypeScript source the bundle used, laid out like the
 * sources below their common directory (src/index.ts → dist/index.d.ts).
 * Oxc's isolated declarations are fast but need explicit types on exports;
 * if any file lacks them, tsc writes all the declarations instead.
 */
async function emitDeclarations(root: string, outDir: string, entries: Record<string, string>, modules: string[]): Promise<string[]> {
    const sources = modules.filter((f) => SOURCE_RE.test(f) && !f.endsWith('.d.ts') && fs.existsSync(f));
    if (!sources.length) return [];
    const base = commonDir([...Object.values(entries), ...sources].map((f) => path.dirname(f)));
    const experimental = requireEsm('rolldown/experimental');
    const declarations: Array<[string, string]> = [];
    let isolated = true;
    for (const file of sources) {
        const result = experimental.isolatedDeclarationSync(file, fs.readFileSync(file, 'utf8'), { stripInternal: true });
        if (result.errors?.length) {
            isolated = false;
            break;
        }
        declarations.push([path.relative(base, file).replace(/\.(m|c)?tsx?$/, (m: string) => (m.startsWith('.m') ? '.d.mts' : m.startsWith('.c') ? '.d.cts' : '.d.ts')), result.code]);
    }
    if (isolated) {
        for (const [rel, code] of declarations) {
            await fsp.mkdir(path.dirname(path.join(outDir, rel)), { recursive: true });
            await fsp.writeFile(path.join(outDir, rel), code);
        }
        return declarations.map(([rel]) => rel.split(path.sep).join('/'));
    }
    return emitWithTsc(root, outDir, base, sources);
}

/**
 * Types next to each entry's output (`math` built from src/utils/math.ts gets
 * dist/math.d.ts), re-exporting the declarations laid out like the sources.
 */
async function entryDeclarations(outDir: string, entries: Record<string, string>, written: string[], outputName: (entryName: string) => string): Promise<string[]> {
    if (!written.length) return [];
    const base = commonDir(Object.values(entries).map((f) => path.dirname(f)));
    const out: string[] = [];
    for (const [entryName, file] of Object.entries(entries)) {
        const name = outputName(entryName);
        const source = path.relative(base, file).replace(/\.(m|c)?tsx?$/, '').split(path.sep).join('/');
        const declared = written.find((w) => w.replace(/\.d\.[mc]?ts$/, '') === source);
        if (!declared || source === name) continue;
        const target = `${name}.d.ts`;
        if (written.includes(target)) continue;
        const code = fs.readFileSync(path.join(outDir, declared), 'utf8');
        const spec = './' + source;
        let stub = `export * from ${JSON.stringify(spec)};\n`;
        if (/\bexport\s+default\b|\bas\s+default\b/.test(code)) stub += `export { default } from ${JSON.stringify(spec)};\n`;
        await fsp.writeFile(path.join(outDir, target), stub);
        out.push(target);
    }
    return out;
}

function emitWithTsc(root: string, outDir: string, base: string, sources: string[]): string[] {
    let tsc: string;
    try {
        tsc = createRequire(path.join(root, 'package.json')).resolve('typescript/bin/tsc');
    } catch {
        console.warn('[lunx lib] some exports have no explicit types and TypeScript is not installed: skipping .d.ts (add explicit return types, or install typescript)');
        return [];
    }
    const before = new Set(listFiles(outDir));
    // A temporary tsconfig that extends the project's: only the bundled sources, declarations only.
    const config = path.join(root, `.lunx-dts-${process.pid}.json`);
    fs.writeFileSync(config, JSON.stringify({
        extends: './tsconfig.json',
        compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, declarationMap: false, outDir, rootDir: base, composite: false, incremental: false, allowImportingTsExtensions: false },
        files: sources,
        include: [],
    }));
    try {
        execFileSync(process.execPath, [tsc, '-p', config], { cwd: root, stdio: 'pipe' });
    } catch (err: any) {
        const out = String(err.stdout ?? '') + String(err.stderr ?? '');
        console.warn(`[lunx lib] tsc reported errors while writing .d.ts files:\n${out.split('\n').slice(0, 15).join('\n')}`);
    } finally {
        fs.rmSync(config, { force: true });
    }
    return listFiles(outDir).filter((f) => !before.has(f) && /\.d\.[cm]?ts$/.test(f));
}

function listFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => f.split(path.sep).join('/')).filter((f) => fs.statSync(path.join(dir, f)).isFile());
}

function commonDir(dirs: string[]): string {
    let common = dirs[0]!;
    for (const d of dirs.slice(1)) {
        while (common !== path.dirname(common) && path.relative(common, d).startsWith('..')) common = path.dirname(common);
    }
    return common;
}

/** package.json fields that point at files the build did not produce. */
export function checkPackageJson(root: string, pkg: any): string[] {
    const problems: string[] = [];
    const check = (field: string, target: unknown) => {
        if (typeof target !== 'string' || /[*]/.test(target)) return;
        if (!fs.existsSync(path.resolve(root, target))) problems.push(`${field} → ${target} does not exist`);
    };
    check('main', pkg.main);
    check('module', pkg.module);
    check('types', pkg.types ?? pkg.typings);
    const walk = (value: unknown, where: string) => {
        if (typeof value === 'string') check(where, value);
        else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${where}[${i}]`));
        else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${where}["${k}"]`);
    };
    walk(pkg.exports, 'exports');
    return problems;
}

/** A suggested package.json `exports` for what was built. */
export function suggestExports(result: LibraryResult, outDirName: string): Record<string, unknown> {
    const byEntry = new Map<string, Record<string, string>>();
    for (const f of result.files) {
        if (f.file.startsWith('chunks/')) continue;
        const entry = f.file.replace(/(\.umd|\.iife)?\.(d\.)?[mc]?[jt]s$/, '');
        if (f.format === 'css') continue;
        const cond = f.format === 'dts' ? 'types' : f.format === 'es' ? 'import' : f.format === 'cjs' ? 'require' : null;
        if (!cond) continue;
        const map = byEntry.get(entry) ?? {};
        map[cond] = `./${outDirName}/${f.file}`;
        byEntry.set(entry, map);
    }
    const exports: Record<string, unknown> = {};
    for (const [entry, map] of byEntry) {
        if (!map.import && !map.require) continue;
        const ordered: Record<string, string> = {};
        for (const k of ['types', 'import', 'require']) if (map[k]) ordered[k] = map[k]!;
        exports[entry === 'index' ? '.' : `./${entry}`] = ordered;
    }
    if (result.files.some((f) => f.format === 'css')) exports[`./${result.files.find((f) => f.format === 'css')!.file}`] = `./${outDirName}/${result.files.find((f) => f.format === 'css')!.file}`;
    return exports;
}
