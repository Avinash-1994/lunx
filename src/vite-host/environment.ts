/**
 * A Vite 6 dev environment (client or ssr): its plugin container, module
 * graph, `transformRequest` pipeline and, for ssr, the module runner behind
 * `ssrLoadModule`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createResolver, ssrTransform, type ModuleResolver } from '../engines/toolkit.js';
import { environmentConfig, type ResolvedConfig } from './config.js';
import { EnvironmentModuleGraph, type EnvironmentModuleNode } from './module-graph.js';
import { PluginContainer } from './plugin-container.js';
import { cleanUrl, isBuiltin, removeTimestampQuery } from './utils.js';

const AsyncFunction = async function () {}.constructor as new (...args: string[]) => (...args: any[]) => Promise<void>;

export interface HotChannel {
    send(payload: any): void;
    send(event: string, data?: any): void;
    on(event: string, listener: (...args: any[]) => void): void;
    off(event: string, listener: (...args: any[]) => void): void;
    listen(): void;
    close(): void | Promise<void>;
}

export function noopHotChannel(): HotChannel {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    return {
        send() {},
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(fn);
        },
        off(event, fn) {
            listeners.get(event)?.delete(fn);
        },
        listen() {},
        close() {},
    };
}

export class LoadError extends Error {
    code = 'ERR_LOAD_URL';
}

export class DevEnvironment {
    readonly mode = 'dev';
    readonly config: any;
    readonly moduleGraph: EnvironmentModuleGraph;
    readonly pluginContainer: PluginContainer;
    readonly logger: any;
    depsOptimizer: any = undefined;
    watcher: any;
    private pending = new Map<string, Promise<any>>();
    private ssrPending = new Map<EnvironmentModuleNode, Promise<Record<string, any>>>();
    private externalResolver?: ModuleResolver;

    constructor(public name: string, private topConfig: ResolvedConfig, public hot: HotChannel, plugins?: any[]) {
        this.config = environmentConfig(topConfig, name);
        this.logger = topConfig.logger;
        this.pluginContainer = new PluginContainer(this, []);
        this.pluginContainer.plugins = applyToEnvironment(plugins ?? topConfig.plugins, this);
        this.moduleGraph = new EnvironmentModuleGraph(name, (url) => this.pluginContainer.resolveId(url, undefined));
    }

    getTopLevelConfig(): ResolvedConfig {
        return this.topConfig;
    }

    get isClient(): boolean {
        return this.config.consumer === 'client';
    }

    async init(): Promise<void> {
        await this.pluginContainer.buildStart();
    }

    async close(): Promise<void> {
        await this.pluginContainer.close();
    }

    async warmupRequest(url: string): Promise<void> {
        await this.transformRequest(url).catch(() => {});
    }

    async transformRequest(rawUrl: string): Promise<{ code: string; map: any; etag?: string; deps?: string[]; dynamicDeps?: string[] } | null> {
        const url = removeTimestampQuery(rawUrl);
        const cached = await this.moduleGraph.getModuleByUrl(url);
        if (cached?.transformResult) return cached.transformResult;
        const inflight = this.pending.get(url);
        if (inflight) return inflight;
        const task = this.doTransform(url, cached).finally(() => this.pending.delete(url));
        this.pending.set(url, task);
        return task;
    }

    private async doTransform(url: string, mod: EnvironmentModuleNode | undefined): Promise<any> {
        const id = mod?.id ?? (await this.pluginContainer.resolveId(url, undefined))?.id ?? url;
        let code: string | null = null;
        let map: any = null;
        const loaded = await this.pluginContainer.load(id);
        if (loaded == null) {
            const file = cleanUrl(id);
            if (path.isAbsolute(file) && fs.existsSync(file) && fs.statSync(file).isFile()) {
                code = fs.readFileSync(file, 'utf-8');
            }
        } else {
            code = loaded.code;
            map = loaded.map ?? null;
        }
        if (code == null) {
            const err = new LoadError(`Failed to load url ${url} (resolved id: ${id}). Does the file exist?`);
            throw err;
        }
        mod ??= await this.moduleGraph.ensureEntryFromUrl(url);
        if (mod.file && this.watcher && path.isAbsolute(mod.file) && !mod.file.includes('node_modules')) this.watcher.add?.(mod.file);
        const transformed = await this.pluginContainer.transform(code, id, { inMap: map });
        let result: any = { code: transformed.code, map: transformed.map, etag: `W/"${transformed.code.length.toString(16)}-${hash(transformed.code)}"` };
        if (!this.isClient) {
            const ssr = await ssrTransform(id, transformed.code);
            result = { code: ssr.code, map: ssr.map ?? null, deps: ssr.deps, dynamicDeps: ssr.dynamicDeps };
        }
        // An invalidation during the transform makes this result stale.
        if (mod.transformResult === null || mod.transformResult === undefined) mod.transformResult = result;
        return result;
    }

    // ── SSR module runner ────────────────────────────────────────────────────

    /** Load a module the way Vite's ssrLoadModule does; externals use Node's own import. */
    async ssrLoadModule(url: string, chain: string[] = []): Promise<Record<string, any>> {
        const mod = await this.moduleGraph.ensureEntryFromUrl(removeTimestampQuery(url));
        if (mod.ssrModule) return mod.ssrModule;
        const pending = this.ssrPending.get(mod);
        if (pending) {
            // A circular import gets the partially evaluated namespace.
            if (chain.includes(mod.url) && (mod as any).__partial) return (mod as any).__partial;
            return pending;
        }
        const task = this.evaluate(mod, url, chain).finally(() => this.ssrPending.delete(mod));
        this.ssrPending.set(mod, task);
        return task;
    }

    private async evaluate(mod: EnvironmentModuleNode, url: string, chain: string[]): Promise<Record<string, any>> {
        const result = await this.transformRequest(mod.url);
        if (!result) throw new Error(`Failed to load module for ssr: ${url}`);
        const exports: Record<string, any> = Object.create(null);
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module', enumerable: false, configurable: false });
        (mod as any).__partial = exports;
        const file = mod.file && path.isAbsolute(mod.file) ? mod.file : path.join(this.topConfig.root, 'index.js');
        const nextChain = [...chain, mod.url];
        const ssrImport = async (dep: string) => {
            if (isBuiltin(dep)) return import(dep.startsWith('node:') ? dep : `node:${dep}`);
            if (dep.startsWith('/') || dep.startsWith('\0')) return this.ssrLoadModule(dep, nextChain);
            if (dep.startsWith('file://')) return import(dep);
            if (/^(https?|data):/.test(dep)) return import(dep);
            return this.importExternal(dep, file);
        };
        const ssrDynamicImport = (dep: string) => {
            if (dep.startsWith('.')) dep = path.posix.resolve(path.posix.dirname(mod.url), dep);
            return ssrImport(dep);
        };
        const exportAll = (source: Record<string, any>) => {
            for (const key in source) {
                if (key !== 'default' && key !== '__esModule' && !(key in exports)) {
                    Object.defineProperty(exports, key, { enumerable: true, configurable: true, get: () => source[key] });
                }
            }
        };
        const importMeta = {
            url: pathToFileURL(file).href,
            filename: file,
            dirname: path.dirname(file),
            env: { ...this.topConfig.env, SSR: true },
            hot: undefined,
            resolve: (spec: string) => pathToFileURL(path.resolve(path.dirname(file), spec)).href,
        };
        try {
            const fn = new AsyncFunction(
                '__vite_ssr_exports__',
                '__vite_ssr_import_meta__',
                '__vite_ssr_import__',
                '__vite_ssr_dynamic_import__',
                '__vite_ssr_exportAll__',
                `"use strict";${result.code}\n//# sourceURL=${file}`,
            );
            await fn(exports, importMeta, ssrImport, ssrDynamicImport, exportAll);
        } catch (err: any) {
            mod.ssrError = err;
            throw err;
        } finally {
            delete (mod as any).__partial;
        }
        mod.ssrModule = exports;
        return exports;
    }

    /** Externalized dependency: resolved with Node's conditions and imported natively. */
    private async importExternal(spec: string, importerFile: string): Promise<any> {
        this.externalResolver ??= createResolver({
            conditionNames: [...(this.config.resolve?.externalConditions ?? ['node']), 'import', 'module-sync', 'default'],
            mainFields: ['main'],
            extensions: ['.mjs', '.js', '.cjs', '.json', '.node'],
        });
        const resolved = this.externalResolver.resolve(path.dirname(importerFile), spec) ?? this.externalResolver.resolve(this.topConfig.root, spec);
        if (!resolved) throw new Error(`Cannot find module '${spec}' imported from ${importerFile}`);
        return import(pathToFileURL(resolved).href);
    }
}

/** Vite 6 `applyToEnvironment`: a plugin can opt out of, or swap itself for, an environment. */
function applyToEnvironment(plugins: any[], env: DevEnvironment): any[] {
    const out: any[] = [];
    for (const plugin of plugins) {
        if (typeof plugin.applyToEnvironment !== 'function') {
            out.push(plugin);
            continue;
        }
        const result = plugin.applyToEnvironment(env);
        if (result === true) out.push(plugin);
        else if (Array.isArray(result)) out.push(...result.filter(Boolean));
        else if (result && typeof result === 'object' && typeof result.then !== 'function') out.push(result);
        else if (result && typeof result.then === 'function') out.push(plugin);
    }
    return out;
}

function hash(text: string): string {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}
