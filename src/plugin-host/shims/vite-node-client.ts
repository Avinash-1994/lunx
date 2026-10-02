/**
 * `vite-node/client`: the module runner side. It asks a server (in-process,
 * or over Nuxt's socket from its Nitro worker) for each module, evaluates the
 * module-runner code it gets back, and imports externalized dependencies with
 * Node. Same evaluation model as the plugin host's ssrLoadModule.
 */

import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AsyncFunction = async function () {}.constructor as new (...args: string[]) => (...args: any[]) => Promise<void>;
const builtins = new Set(builtinModules);

export interface ModuleCache {
    promise?: Promise<any>;
    exports?: any;
    evaluated?: boolean;
    resolving?: boolean;
    code?: string;
    importers?: Set<string>;
    imports?: Set<string>;
}

function normalizeId(id: string): string {
    return id.replace(/^\/@fs\//, '/').replace(/^file:\/\//, '').replace(/^\/@id\/__x00__/, '\0').replace(/^\/@id\//, '').replace(/[?&]v=\w+/, '').replace(/\?$/, '');
}

export class ModuleCacheMap extends Map<string, ModuleCache> {
    normalizePath(fsPath: string): string {
        return normalizeId(fsPath);
    }

    override get(fsPath: string): ModuleCache {
        const key = this.normalizePath(fsPath);
        let mod = super.get(key);
        if (!mod) {
            mod = { importers: new Set(), imports: new Set() };
            super.set(key, mod);
        }
        return mod;
    }

    override set(fsPath: string, mod: ModuleCache): this {
        return super.set(this.normalizePath(fsPath), mod);
    }

    update(fsPath: string, mod: ModuleCache): this {
        Object.assign(this.get(fsPath), mod);
        return this;
    }

    setByModuleId(id: string, mod: ModuleCache): ModuleCache {
        return this.set(id, mod).get(id);
    }

    getByModuleId(id: string): ModuleCache {
        return this.get(id);
    }

    override delete(fsPath: string): boolean {
        return super.delete(this.normalizePath(fsPath));
    }

    invalidateModule(mod: ModuleCache): boolean {
        delete mod.evaluated;
        delete mod.resolving;
        delete mod.promise;
        delete mod.exports;
        mod.importers?.clear();
        mod.imports?.clear();
        return true;
    }

    /** Drop these modules and everything that imports them; returns the dropped ids. */
    invalidateDepTree(ids: string[] | Set<string>, invalidated = new Set<string>()): Set<string> {
        for (const raw of ids) {
            const id = this.normalizePath(raw);
            if (invalidated.has(id)) continue;
            invalidated.add(id);
            const mod = super.get(id);
            if (mod?.importers) this.invalidateDepTree(mod.importers, invalidated);
            super.delete(id);
        }
        return invalidated;
    }

    invalidateSubDepTree(ids: string[] | Set<string>, invalidated = new Set<string>()): Set<string> {
        for (const raw of ids) {
            const id = this.normalizePath(raw);
            if (invalidated.has(id)) continue;
            invalidated.add(id);
            const subIds = [...super.entries()].filter(([, m]) => m.importers?.has(id)).map(([k]) => k);
            if (subIds.length) this.invalidateSubDepTree(subIds, invalidated);
            super.delete(id);
        }
        return invalidated;
    }

    getSourceMap(): null {
        return null;
    }
}

export interface ViteNodeRunnerOptions {
    root: string;
    base?: string;
    fetchModule(id: string): Promise<{ code?: string; externalize?: string; map?: any }>;
    resolveId?(id: string, importer?: string): Promise<{ id: string; external?: boolean } | null | undefined>;
    moduleCache?: ModuleCacheMap;
    interopDefault?: boolean;
    requestStubs?: Record<string, any>;
    debug?: boolean;
}

export class ViteNodeRunner {
    readonly root: string;
    readonly moduleCache: ModuleCacheMap;

    constructor(public options: ViteNodeRunnerOptions) {
        this.root = options.root ?? process.cwd();
        this.moduleCache = options.moduleCache ?? new ModuleCacheMap();
    }

    async executeFile(file: string): Promise<any> {
        const url = `/@fs/${path.resolve(this.root, file).replace(/^\//, '')}`;
        return this.cachedRequest(url, path.resolve(this.root, file), []);
    }

    async executeId(rawId: string): Promise<any> {
        const [id, fsPath] = await this.resolveUrl(rawId);
        return this.cachedRequest(id, fsPath, []);
    }

    shouldResolveId(id: string): boolean {
        return !(id.startsWith('node:') || builtins.has(id) || id.startsWith('data:') || /^https?:/.test(id));
    }

    async resolveUrl(id: string, importer?: string): Promise<[string, string]> {
        if (!this.shouldResolveId(id)) return [id, id];
        if (importer && id.startsWith('.')) id = path.resolve(path.dirname(importer), id);
        const resolved = this.options.resolveId ? await this.options.resolveId(id, importer) : null;
        const resolvedId = resolved?.id ? normalizeId(resolved.id) : normalizeId(id);
        return [resolvedId, resolvedId];
    }

    async dependencyRequest(id: string, fsPath: string, callstack: string[]): Promise<any> {
        const mod = this.moduleCache.get(fsPath);
        // A cycle gets the partially evaluated exports.
        if (callstack.includes(fsPath) && mod.exports) return mod.exports;
        return this.cachedRequest(id, fsPath, callstack);
    }

    async cachedRequest(id: string, fsPath: string, callstack: string[]): Promise<any> {
        const importee = callstack[callstack.length - 1];
        const mod = this.moduleCache.get(fsPath);
        if (importee) mod.importers!.add(normalizeId(importee));
        if (mod.promise) return mod.promise;
        const promise = this.directRequest(id, fsPath, callstack);
        Object.assign(mod, { promise, evaluated: false });
        try {
            return await promise;
        } finally {
            mod.evaluated = true;
        }
    }

    async directRequest(id: string, fsPath: string, callstack: string[]): Promise<any> {
        const stub = this.options.requestStubs?.[id];
        if (stub) return stub;
        const mod = this.moduleCache.get(fsPath);
        const fetched = await this.options.fetchModule(id);
        if (fetched.externalize != null) {
            const exports = await this.interopedImport(fetched.externalize);
            mod.exports = exports;
            return exports;
        }
        const code = fetched.code ?? '';
        const file = fsPath.startsWith('\0') || !path.isAbsolute(fsPath) ? path.join(this.root, 'index.js') : fsPath;
        const exports: Record<string, any> = Object.create(null);
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module', enumerable: false });
        mod.exports = exports;
        mod.code = code;
        const nextStack = [...callstack, fsPath];
        const request = async (dep: string) => {
            const [depId, depPath] = await this.resolveUrl(dep, file);
            mod.imports!.add(depPath);
            if (!this.shouldResolveId(depId)) return this.interopedImport(depId);
            return this.dependencyRequest(depId, depPath, nextStack);
        };
        const dynamicRequest = (dep: string) => request(dep.startsWith('.') ? path.resolve(path.dirname(file), dep) : dep);
        const exportAll = (source: any) => {
            if (!source || typeof source !== 'object') return;
            for (const key in source) {
                if (key !== 'default' && key !== '__esModule' && !(key in exports)) {
                    Object.defineProperty(exports, key, { enumerable: true, configurable: true, get: () => source[key] });
                }
            }
        };
        const meta = {
            url: pathToFileURL(file).href,
            filename: file,
            dirname: path.dirname(file),
            env: { ...process.env, SSR: true, DEV: true, PROD: false, MODE: 'development', BASE_URL: this.options.base ?? '/' },
            hot: undefined,
            resolve: (spec: string) => pathToFileURL(path.resolve(path.dirname(file), spec)).href,
        };
        const cjsModule = { exports };
        const fn = new AsyncFunction(
            '__vite_ssr_import__',
            '__vite_ssr_dynamic_import__',
            '__vite_ssr_exports__',
            '__vite_ssr_exportAll__',
            '__vite_ssr_import_meta__',
            'require',
            'exports',
            'module',
            '__filename',
            '__dirname',
            `"use strict";${code}\n//# sourceURL=${file}`,
        );
        await fn(request, dynamicRequest, exports, exportAll, meta, createRequire(file), exports, cjsModule, file, path.dirname(file));
        return exports;
    }

    /** Import an externalized dependency with Node, with Vite's default interop. */
    async interopedImport(target: string): Promise<any> {
        const spec = builtins.has(target) && !target.startsWith('node:') ? `node:${target}` : target;
        const url = path.isAbsolute(spec) ? pathToFileURL(spec).href : spec;
        const mod = await import(url);
        if (this.options.interopDefault === false || !mod || !('default' in mod)) return mod;
        const def = mod.default;
        if (def && typeof def === 'object' && !Array.isArray(def) && Object.keys(mod).length === 1) {
            return new Proxy(mod, {
                get: (t, p) => (p in t ? (t as any)[p] : def[p]),
                has: (t, p) => p in t || p in def,
            });
        }
        return mod;
    }
}

export { fileURLToPath };
export default { ViteNodeRunner, ModuleCacheMap };
