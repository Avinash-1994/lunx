/**
 * webpack loaders in lunx (`loaders` in lunx.config, webpack's `module.rules`
 * shape): a rule's loaders run on a matching file, right to left, with the
 * loader context webpack gives them (async / callback, getOptions, resourcePath,
 * dependencies, emitFile, resolve, raw and pitching loaders), in builds and in
 * dev. Their output is the module: JavaScript (ES or CommonJS), or what an
 * asset `type` makes of it.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

type Condition = RegExp | string | ((value: string) => boolean) | Condition[];
type LoaderUse = string | { loader: string; options?: unknown };

export interface LoaderRule {
    test?: Condition;
    include?: Condition;
    exclude?: Condition;
    /** Matched against the import's query (`?inline`). */
    resourceQuery?: Condition;
    use?: LoaderUse | LoaderUse[];
    /** `{ loader, options }` in place of `use`. */
    loader?: string;
    options?: unknown;
    /** webpack's asset modules: the file (after the loaders) as a string, an emitted file's URL, or a data URL. */
    type?: 'javascript/auto' | 'asset/source' | 'asset/resource' | 'asset/inline';
}

export interface LoaderResult {
    /** The module: JavaScript. */
    code: string;
    map?: string | null;
    /** Files the loaders read (watched). */
    dependencies: string[];
}

export interface LoaderHost {
    mode: 'development' | 'production';
    /** Emits a file into the output (or serves it in dev); returns its public URL. */
    emitFile(name: string, content: Buffer | string): string;
    warn(message: string): void;
}

interface Loader {
    request: string;
    path: string;
    options: unknown;
    query: string;
    fn: ((this: any, content: any, map?: any, meta?: any) => any) & { raw?: boolean; pitch?: (...args: any[]) => any };
}

const matches = (condition: Condition | undefined, value: string): boolean => {
    if (condition === undefined) return true;
    if (Array.isArray(condition)) return condition.some((c) => matches(c, value));
    if (condition instanceof RegExp) {
        condition.lastIndex = 0;
        return condition.test(value);
    }
    if (typeof condition === 'function') return !!condition(value);
    // A string is a path prefix (webpack's include / exclude).
    return value.startsWith(condition);
};

export class LoaderRunner {
    private readonly require: NodeRequire;
    private readonly modules = new Map<string, Promise<Loader['fn']>>();

    constructor(private readonly root: string, private readonly rules: LoaderRule[], private readonly host: LoaderHost) {
        this.require = createRequire(path.join(root, 'package.json'));
    }

    /** The rules for a file (path without query) and its query. */
    rulesFor(file: string, query = ''): LoaderRule[] {
        return this.rules.filter(
            (r) => (r.test === undefined || matches(r.test, file)) && matches(r.include, file) && !(r.exclude !== undefined && matches(r.exclude, file)) && (r.resourceQuery === undefined || matches(r.resourceQuery, query)),
        );
    }

    /** A regular expression covering every rule's `test`, for a bundler's hook filter (null: no static filter). */
    filter(): RegExp | null {
        const sources: string[] = [];
        for (const r of this.rules) {
            if (!(r.test instanceof RegExp)) return null;
            sources.push(r.test.source);
        }
        return sources.length ? new RegExp(sources.map((s) => `(?:${s})`).join('|')) : null;
    }

    private async loadLoader(use: LoaderUse): Promise<Loader> {
        const spec = typeof use === 'string' ? use : use.loader;
        const [name, query = ''] = spec.split(/\?(.*)/s) as [string, string?];
        let options: unknown = typeof use === 'string' ? undefined : use.options;
        if (options === undefined && query) {
            try {
                options = JSON.parse(query);
            } catch {
                options = Object.fromEntries(new URLSearchParams(query));
            }
        }
        const file = path.isAbsolute(name) ? name : this.require.resolve(name);
        let mod = this.modules.get(file);
        if (!mod) {
            mod = (async () => {
                let m: any;
                try {
                    m = this.require(file);
                } catch (err: any) {
                    if (err?.code !== 'ERR_REQUIRE_ESM' && err?.code !== 'ERR_REQUIRE_ASYNC_MODULE') throw err;
                    m = await import(pathToFileURL(file).href);
                }
                const fn = typeof m === 'function' ? m : typeof m?.default === 'function' ? Object.assign(m.default, { raw: m.raw ?? m.default.raw, pitch: m.pitch ?? m.default.pitch }) : null;
                if (!fn) throw new Error(`${name} is not a webpack loader (no function export)`);
                return fn;
            })();
            this.modules.set(file, mod);
        }
        return { request: spec, path: file, options, query: query ? `?${query}` : '', fn: await mod };
    }

    /** Runs the matching rules' loaders on a file. */
    async run(file: string, query: string, rules: LoaderRule[] = this.rulesFor(file, query), emitFile: LoaderHost['emitFile'] = this.host.emitFile): Promise<LoaderResult> {
        const uses = rules.flatMap((r) => (r.use !== undefined ? ([] as LoaderUse[]).concat(r.use) : r.loader ? [{ loader: r.loader, options: r.options }] : []));
        const loaders = await Promise.all(uses.map((u) => this.loadLoader(u)));
        const type = [...rules].reverse().find((r) => r.type)?.type;
        const dependencies = new Set<string>([file]);
        const resource = file + query;
        const datas = loaders.map(() => ({}));
        let index = 0;
        const requestOf = (from: number) => [...loaders.slice(from).map((l) => l.request), resource].join('!');
        const resolveFn = (options: any = {}) => (context: string, request: string, callback?: (err: Error | null, result?: string) => void) => {
            const p = (async () => {
                const req = createRequire(path.join(context, 'noop.js'));
                try {
                    return req.resolve(request, options.paths ? { paths: options.paths } : undefined);
                } catch {
                    for (const ext of options.extensions ?? ['.js', '.ts', '.tsx', '.jsx', '.json']) {
                        const candidate = path.resolve(context, request + ext);
                        if (fs.existsSync(candidate)) return candidate;
                    }
                    throw new Error(`Can't resolve '${request}' in '${context}'`);
                }
            })();
            if (callback) p.then((r) => callback(null, r), (e) => callback(e));
            return p;
        };
        const ctx: any = {
            version: 2,
            webpack: true,
            mode: this.host.mode,
            target: 'web',
            sourceMap: this.host.mode === 'development',
            hot: false,
            rootContext: this.root,
            context: path.dirname(file),
            resource,
            resourcePath: file,
            resourceQuery: query,
            resourceFragment: '',
            fs,
            loaders: loaders.map((l, i) => ({ request: l.request, path: l.path, query: l.query, options: l.options, get data() { return datas[i]; } })),
            get loaderIndex() { return index; },
            get data() { return datas[index]; },
            get query() { return loaders[index]?.options ?? loaders[index]?.query ?? ''; },
            get request() { return requestOf(0); },
            get currentRequest() { return requestOf(index); },
            get remainingRequest() { return requestOf(index + 1); },
            get previousRequest() { return loaders.slice(0, index).map((l) => l.request).join('!'); },
            getOptions: () => (typeof loaders[index]?.options === 'object' && loaders[index]?.options !== null ? loaders[index]!.options : {}),
            cacheable: () => {},
            addDependency: (f: string) => dependencies.add(f),
            dependency: (f: string) => dependencies.add(f),
            addContextDependency: () => {},
            addMissingDependency: () => {},
            addBuildDependency: () => {},
            getDependencies: () => [...dependencies],
            getContextDependencies: () => [],
            getMissingDependencies: () => [],
            clearDependencies: () => dependencies.clear(),
            emitFile: (name: string, content: Buffer | string) => emitFile(name, content),
            emitWarning: (w: unknown) => this.host.warn(`${path.relative(this.root, file)}: ${w instanceof Error ? w.message : String(w)}`),
            emitError: (e: unknown) => this.host.warn(`${path.relative(this.root, file)}: ${e instanceof Error ? e.message : String(e)}`),
            getLogger: () => ({ log: () => {}, info: () => {}, debug: () => {}, warn: (m: string) => this.host.warn(m), error: (m: string) => this.host.warn(m) }),
            resolve: (context: string, request: string, callback: (err: Error | null, result?: string) => void) => resolveFn()(context, request, callback),
            getResolve: (options?: any) => resolveFn(options),
            importModule: () => Promise.reject(new Error('importModule is not supported by lunx')),
            loadModule: (_r: string, cb: (err: Error) => void) => cb(new Error('loadModule is not supported by lunx')),
            utils: {
                absolutify: (context: string, request: string) => path.resolve(context, request),
                contextify: (context: string, request: string) => {
                    const rel = path.relative(context, request).split(path.sep).join('/');
                    return rel.startsWith('.') ? rel : `./${rel}`;
                },
                createHash: (algorithm = 'md4') => crypto.createHash(algorithm === 'md4' ? 'md5' : algorithm),
            },
        };

        /** Calls one loader function, sync or async, with webpack's calling conventions. */
        const call = (fn: (...args: any[]) => any, args: any[]): Promise<any[]> =>
            new Promise((resolve, reject) => {
                let done = false;
                let isAsync = false;
                const finish = (err: unknown, ...results: any[]) => {
                    if (done) return;
                    done = true;
                    if (err) reject(err);
                    else resolve(results);
                };
                ctx.async = () => {
                    isAsync = true;
                    return finish;
                };
                ctx.callback = (err: unknown, ...results: any[]) => {
                    isAsync = true;
                    finish(err, ...results);
                };
                let out: any;
                try {
                    out = fn.apply(ctx, args);
                } catch (err) {
                    return finish(err);
                }
                if (isAsync) return;
                if (out && typeof out.then === 'function') out.then((v: any) => finish(null, v), (e: any) => finish(e));
                else finish(null, out);
            });

        // Pitching: left to right; a pitch that returns a result skips the loaders after it.
        let start = loaders.length;
        let pitched: any[] | null = null;
        for (index = 0; index < loaders.length; index++) {
            const pitch = loaders[index]!.fn.pitch;
            if (!pitch) continue;
            const [result] = await call(pitch, [requestOf(index + 1), loaders.slice(0, index).map((l) => l.request).join('!'), datas[index]]);
            if (result !== undefined) {
                start = index;
                pitched = [result];
                break;
            }
        }
        let args: any[] = pitched ?? [fs.readFileSync(file)];
        for (index = start - 1; index >= 0; index--) {
            const loader = loaders[index]!;
            const content = args[0];
            args[0] = loader.fn.raw ? (Buffer.isBuffer(content) ? content : Buffer.from(String(content))) : Buffer.isBuffer(content) ? content.toString('utf8') : content;
            args = await call(loader.fn, args);
        }

        const output: Buffer | string = args[0] ?? '';
        const map = args[1] ? (typeof args[1] === 'string' ? args[1] : JSON.stringify(args[1])) : null;
        let code: string;
        if (type === 'asset/source') code = `export default ${JSON.stringify(output.toString())};`;
        else if (type === 'asset/resource') code = `export default ${JSON.stringify(emitFile(assetName(file, output), output))};`;
        else if (type === 'asset/inline') code = `export default ${JSON.stringify(`data:${mimeOf(file)};base64,${Buffer.from(output).toString('base64')}`)};`;
        else code = output.toString();
        return { code, map, dependencies: [...dependencies] };
    }
}

function assetName(file: string, content: Buffer | string): string {
    const ext = path.extname(file);
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
    return `assets/${path.basename(file, ext)}.${hash}${ext}`;
}

function mimeOf(file: string): string {
    const ext = path.extname(file).slice(1).toLowerCase();
    return ({ svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', json: 'application/json' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

/**
 * Loader output for the browser as it is (dev serves modules unbundled): CommonJS
 * (`module.exports = …`, `require(…)`) becomes an ES module.
 */
export function toBrowserModule(code: string): string {
    if (/(^|[^.\w$])(import|export)\s*[\s{*'"\w]/m.test(code) && !/(^|[^.\w$])module\.exports\b/.test(code)) return code;
    if (!/(^|[^.\w$])(module\.exports|exports\.\w+|require\s*\()/.test(code)) return code;
    const imports: string[] = [];
    const body = code.replace(/(^|[^.\w$])require\(\s*(["'])([^"']+)\2\s*\)/g, (_m, lead: string, _q: string, spec: string) => {
        const name = `__lunx_req${imports.length}`;
        imports.push(`import * as ${name} from ${JSON.stringify(spec)};`);
        return `${lead}(${name}.default ?? ${name})`;
    });
    return `${imports.join('\n')}\nconst module = { exports: {} }; const exports = module.exports;\n${body}\nexport default (module.exports && module.exports.__esModule && 'default' in module.exports) ? module.exports.default : module.exports;\n`;
}
