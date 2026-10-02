/**
 * Runs the Rollup-shaped hooks of Vite plugins during dev, with the plugin
 * context they expect (`this.resolve`, `this.environment`, `this.error`, …),
 * hook ordering (`order: 'pre' | 'post'`) and hook filters.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseCode } from '../engines/index.js';
import { getHookHandler, sortByHook } from './config.js';
import { globToRegExp } from '../lib/watcher.js';
import { cleanUrl, slash, VERSION } from './utils.js';

export interface PartialResolvedId {
    id: string;
    external?: boolean | 'absolute' | 'relative';
    meta?: Record<string, any>;
    moduleSideEffects?: boolean | 'no-treeshake' | null;
    resolvedBy?: string;
}

export interface ResolveIdOptions {
    attributes?: Record<string, string>;
    custom?: Record<string, any>;
    isEntry?: boolean;
    skip?: Set<any>;
    scan?: boolean;
    skipCalls?: Array<{ id: string; importer?: string; plugin: any }>;
}

export interface TransformResult {
    code: string;
    map: any;
}

type Matcher = (value: string) => boolean;

function toMatcher(pattern: string | RegExp, forId: boolean): Matcher {
    if (pattern instanceof RegExp) {
        return (v) => {
            pattern.lastIndex = 0;
            return pattern.test(v);
        };
    }
    if (!forId) return (v) => v.includes(pattern);
    const re = /[*?{[]/.test(pattern) ? globToRegExp(slash(pattern)) : null;
    return re ? (v) => re.test(slash(v)) : (v) => v === pattern;
}

function compilePatternFilter(spec: any, forId: boolean): Matcher | null {
    if (spec == null) return null;
    let include: any[] = [];
    let exclude: any[] = [];
    if (typeof spec === 'string' || spec instanceof RegExp) include = [spec];
    else if (Array.isArray(spec)) include = spec;
    else {
        include = spec.include == null ? [] : [].concat(spec.include);
        exclude = spec.exclude == null ? [] : [].concat(spec.exclude);
    }
    const inc = include.map((p) => toMatcher(p, forId));
    const exc = exclude.map((p) => toMatcher(p, forId));
    return (value) => {
        if (exc.some((m) => m(value))) return false;
        return inc.length === 0 || inc.some((m) => m(value));
    };
}

const filterCache = new WeakMap<object, { id: Matcher | null; code: Matcher | null }>();

/** Hook filter (Vite 6.3 / Rolldown): skip the call when it cannot match. */
function passesFilter(hook: any, id: string, code?: string): boolean {
    if (typeof hook !== 'object' || !hook?.filter) return true;
    let compiled = filterCache.get(hook);
    if (!compiled) {
        compiled = { id: compilePatternFilter(hook.filter.id, true), code: compilePatternFilter(hook.filter.code, false) };
        filterCache.set(hook, compiled);
    }
    if (compiled.id && !compiled.id(id)) return false;
    if (code !== undefined && compiled.code && !compiled.code(code)) return false;
    return true;
}

export class PluginContainer {
    readonly watchFiles = new Set<string>();
    readonly moduleMeta = new Map<string, Record<string, any>>();
    private started: Promise<void> | null = null;
    private closed = false;

    constructor(public environment: any, public plugins: any[]) {}

    private context(plugin: any, extra: Record<string, any> = {}): any {
        // Hook functions get `ctx` as `this`; keep a handle on the container.
        const { resolveId, moduleMeta, watchFiles } = { resolveId: this.resolveId.bind(this), moduleMeta: this.moduleMeta, watchFiles: this.watchFiles };
        const env = this.environment;
        const ctx: any = {
            environment: env,
            meta: { rollupVersion: '4.40.0', viteVersion: VERSION, watchMode: env.mode === 'dev', rolldownVersion: '1.2.12' },
            cache: { has: () => false, get: () => undefined, set: () => {}, delete: () => false },
            fs: fs.promises,
            parse(code: string, opts?: any) {
                return parseCode('module.js', code, opts?.jsx ? 'jsx' : 'js');
            },
            async resolve(id: string, importer?: string, options?: ResolveIdOptions & { skipSelf?: boolean }) {
                const skip = new Set<any>(extra.skip ?? []);
                if (options?.skipSelf !== false) skip.add(plugin);
                return resolveId(id, importer, { ...options, skip });
            },
            async load(options: { id: string }) {
                await env.transformRequest?.(options.id).catch(() => null);
                return ctx.getModuleInfo(options.id);
            },
            getModuleInfo(id: string) {
                const node = env.moduleGraph?.getModuleById(id);
                const meta = moduleMeta.get(id) ?? (node ? (node.meta ??= {}) : null);
                if (!node && !meta) return null;
                return {
                    id,
                    meta: meta ?? {},
                    code: null,
                    isEntry: false,
                    isExternal: false,
                    importers: node ? [...node.importers].map((m: any) => m.id).filter(Boolean) : [],
                    importedIds: node ? [...node.importedModules].map((m: any) => m.id).filter(Boolean) : [],
                    dynamicImporters: [],
                    dynamicallyImportedIds: [],
                    exports: null,
                    hasDefaultExport: null,
                    moduleSideEffects: true,
                    syntheticNamedExports: false,
                };
            },
            getModuleIds() {
                return env.moduleGraph ? env.moduleGraph.idToModuleMap.keys() : [][Symbol.iterator]();
            },
            addWatchFile(file: string) {
                watchFiles.add(file);
                env.watcher?.add?.(file);
            },
            getWatchFiles() {
                return [...watchFiles];
            },
            emitFile() {
                env.logger?.warnOnce?.(`[plugin ${plugin.name}] emitFile() is not supported in serve mode.`);
                return '';
            },
            setAssetSource() {},
            getFileName() {
                throw new Error('getFileName() is not supported in serve mode');
            },
            warn(warning: any) {
                const msg = typeof warning === 'string' ? warning : warning.message;
                env.logger?.warn(`[plugin ${plugin.name}] ${msg}`);
            },
            info(message: any) {
                env.logger?.info(`[plugin ${plugin.name}] ${typeof message === 'string' ? message : message.message}`);
            },
            debug() {},
            error(e: any): never {
                const err: any = typeof e === 'string' ? new Error(e) : e;
                err.plugin = plugin.name;
                if (extra.id && !err.id) err.id = extra.id;
                throw err;
            },
            getCombinedSourcemap() {
                return { version: 3, sources: [], names: [], mappings: '' };
            },
            ...extra,
        };
        return ctx;
    }

    async buildStart(): Promise<void> {
        if (this.started) return this.started;
        this.started = (async () => {
            await Promise.all(
                sortByHook(this.plugins, 'options').map((p) => getHookHandler(p.options)!.call(this.context(p), {})),
            );
            await Promise.all(
                sortByHook(this.plugins, 'buildStart').map((p) => getHookHandler(p.buildStart)!.call(this.context(p), {})),
            );
        })();
        return this.started;
    }

    async resolveId(rawId: string, importer: string | undefined = path.join(this.environment.config.root, 'index.html'), options: ResolveIdOptions = {}): Promise<PartialResolvedId | null> {
        const skip = options.skip;
        let id: string | null = null;
        const partial: Partial<PartialResolvedId> = {};
        for (const plugin of sortByHook(this.plugins, 'resolveId')) {
            if (skip?.has(plugin)) continue;
            const hook = plugin.resolveId;
            if (!passesFilter(hook, rawId)) continue;
            const ctx = this.context(plugin, { skip });
            let result: any;
            try {
                result = await getHookHandler(hook)!.call(ctx, rawId, importer, {
                    attributes: options.attributes ?? {},
                    custom: options.custom,
                    isEntry: !!options.isEntry,
                    ssr: this.environment.config.consumer === 'server',
                    scan: !!options.scan,
                });
            } catch (err: any) {
                err.plugin ??= plugin.name;
                throw err;
            }
            if (result == null || result === false) continue;
            if (typeof result === 'string') id = result;
            else {
                id = result.id;
                Object.assign(partial, result);
            }
            partial.resolvedBy = plugin.name;
            break;
        }
        if (id == null) return null;
        partial.id = /^[a-z]+:/i.test(id) || id.startsWith('\0') ? id : id;
        if (partial.meta) this.moduleMeta.set(id, { ...this.moduleMeta.get(id), ...partial.meta });
        return partial as PartialResolvedId;
    }

    async load(id: string): Promise<{ code: string; map?: any; moduleType?: string } | null> {
        for (const plugin of sortByHook(this.plugins, 'load')) {
            const hook = plugin.load;
            if (!passesFilter(hook, id)) continue;
            const ctx = this.context(plugin, { id });
            let result: any;
            try {
                result = await getHookHandler(hook)!.call(ctx, id, { ssr: this.environment.config.consumer === 'server' });
            } catch (err: any) {
                err.plugin ??= plugin.name;
                err.id ??= id;
                throw err;
            }
            if (result == null) continue;
            if (typeof result === 'string') return { code: result };
            if (result.meta) this.moduleMeta.set(id, { ...this.moduleMeta.get(id), ...result.meta });
            return result;
        }
        return null;
    }

    async transform(code: string, id: string, options: { inMap?: any; moduleType?: string } = {}): Promise<TransformResult> {
        let map = options.inMap ?? null;
        for (const plugin of sortByHook(this.plugins, 'transform')) {
            const hook = plugin.transform;
            if (!passesFilter(hook, id, code)) continue;
            const ctx = this.context(plugin, { id, originalCode: code });
            let result: any;
            try {
                result = await getHookHandler(hook)!.call(ctx, code, id, { ssr: this.environment.config.consumer === 'server', moduleType: options.moduleType ?? 'js' });
            } catch (err: any) {
                err.plugin ??= plugin.name;
                err.id ??= id;
                throw err;
            }
            if (result == null) continue;
            if (typeof result === 'string') code = result;
            else {
                if (result.code != null) code = result.code;
                if (result.map) map = result.map;
                if (result.meta) this.moduleMeta.set(id, { ...this.moduleMeta.get(id), ...result.meta });
            }
        }
        return { code, map };
    }

    async watchChange(id: string, change: { event: 'create' | 'update' | 'delete' }): Promise<void> {
        await Promise.all(
            sortByHook(this.plugins, 'watchChange').map((p) => getHookHandler(p.watchChange)!.call(this.context(p), id, change)),
        );
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const hook of ['buildEnd', 'closeBundle']) {
            await Promise.all(sortByHook(this.plugins, hook).map((p) => getHookHandler(p[hook])!.call(this.context(p))));
        }
    }

    /** The id a URL-ish request maps to before any plugin claims it. */
    static fallbackId(root: string, url: string): string {
        return path.join(root, cleanUrl(url));
    }
}
