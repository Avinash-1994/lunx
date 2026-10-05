/**
 * Vite's module graph: one per environment (client, ssr) plus the mixed
 * `server.moduleGraph` view older plugins (SvelteKit, Astro…) still read.
 */

import path from 'node:path';
import { cleanUrl, isCSSRequest, isJSRequest, removeImportQuery, removeTimestampQuery, unwrapId } from './utils.js';

export class EnvironmentModuleNode {
    id: string | null = null;
    file: string | null = null;
    type: 'js' | 'css' | 'asset';
    info?: any;
    meta?: Record<string, any>;
    importers = new Set<EnvironmentModuleNode>();
    importedModules = new Set<EnvironmentModuleNode>();
    acceptedHmrDeps = new Set<EnvironmentModuleNode>();
    acceptedHmrExports: Set<string> | null = null;
    importedBindings: Map<string, Set<string>> | null = null;
    isSelfAccepting?: boolean;
    transformResult: any = null;
    /** SSR: the evaluated module namespace. */
    ssrModule: Record<string, any> | null = null;
    ssrError: Error | null = null;
    lastHMRTimestamp = 0;
    lastHMRInvalidationReceived = false;
    lastInvalidationTimestamp = 0;
    invalidationState: any;
    staticImportedUrls?: Set<string>;

    constructor(public url: string, public environment: string, setIsSelfAccepting = true) {
        this.type = isDirectCSS(url) ? 'css' : isJSRequest(url) || isCSSRequest(url) ? 'js' : 'asset';
        if (setIsSelfAccepting) this.isSelfAccepting = false;
    }
}

function isDirectCSS(url: string): boolean {
    return isCSSRequest(url) && /[?&]direct\b/.test(url);
}

export class EnvironmentModuleGraph {
    urlToModuleMap = new Map<string, EnvironmentModuleNode>();
    idToModuleMap = new Map<string, EnvironmentModuleNode>();
    etagToModuleMap = new Map<string, EnvironmentModuleNode>();
    fileToModulesMap = new Map<string, Set<EnvironmentModuleNode>>();

    constructor(public environment: string, private resolveId: (url: string) => Promise<{ id: string; meta?: any } | null>) {}

    async getModuleByUrl(rawUrl: string): Promise<EnvironmentModuleNode | undefined> {
        rawUrl = unwrapId(removeImportQuery(removeTimestampQuery(rawUrl)));
        const mod = this.urlToModuleMap.get(rawUrl);
        if (mod) return mod;
        const [url] = await this.resolveUrl(rawUrl);
        return this.urlToModuleMap.get(url);
    }

    getModuleById(id: string): EnvironmentModuleNode | undefined {
        return this.idToModuleMap.get(removeTimestampQuery(id));
    }

    getModulesByFile(file: string): Set<EnvironmentModuleNode> | undefined {
        return this.fileToModulesMap.get(file);
    }

    onFileChange(file: string): void {
        const mods = this.getModulesByFile(file);
        if (!mods) return;
        const seen = new Set<EnvironmentModuleNode>();
        for (const mod of mods) this.invalidateModule(mod, seen);
    }

    onFileDelete(file: string): void {
        const mods = this.getModulesByFile(file);
        if (!mods) return;
        for (const mod of mods) {
            for (const imported of mod.importedModules) imported.importers.delete(mod);
        }
    }

    /**
     * Drop a module's transform result. SSR also drops everything that
     * imports it, so the next ssrLoadModule re-evaluates the whole chain.
     */
    invalidateModule(mod: EnvironmentModuleNode, seen = new Set<EnvironmentModuleNode>(), timestamp = Date.now(), isHmr = false, softInvalidate = false): void {
        if (seen.has(mod)) return;
        seen.add(mod);
        if (isHmr) {
            mod.lastHMRTimestamp = timestamp;
            mod.lastHMRInvalidationReceived = false;
        } else {
            mod.lastInvalidationTimestamp = timestamp;
        }
        mod.transformResult = null;
        mod.ssrModule = null;
        mod.ssrError = null;
        if (softInvalidate) return;
        if (this.environment !== 'client') {
            for (const importer of mod.importers) {
                if (!importer.acceptedHmrDeps.has(mod)) this.invalidateModule(importer, seen, timestamp, isHmr);
            }
        }
    }

    invalidateAll(): void {
        const timestamp = Date.now();
        const seen = new Set<EnvironmentModuleNode>();
        for (const mod of this.idToModuleMap.values()) this.invalidateModule(mod, seen, timestamp);
    }

    async updateModuleInfo(
        mod: EnvironmentModuleNode,
        importedModules: Set<string | EnvironmentModuleNode>,
        importedBindings: Map<string, Set<string>> | null,
        acceptedModules: Set<string | EnvironmentModuleNode>,
        acceptedExports: Set<string> | null,
        isSelfAccepting: boolean,
        staticImportedUrls?: Set<string>,
    ): Promise<Set<EnvironmentModuleNode> | undefined> {
        mod.isSelfAccepting = isSelfAccepting;
        const prevImports = mod.importedModules;
        const next = new Set<EnvironmentModuleNode>();
        for (const imported of importedModules) {
            const dep = typeof imported === 'string' ? await this.ensureEntryFromUrl(imported) : imported;
            dep.importers.add(mod);
            next.add(dep);
        }
        let noLongerImported: Set<EnvironmentModuleNode> | undefined;
        for (const dep of prevImports) {
            if (!next.has(dep)) {
                dep.importers.delete(mod);
                if (!dep.importers.size) (noLongerImported ??= new Set()).add(dep);
            }
        }
        mod.importedModules = next;
        const accepted = new Set<EnvironmentModuleNode>();
        for (const a of acceptedModules) accepted.add(typeof a === 'string' ? await this.ensureEntryFromUrl(a) : a);
        mod.acceptedHmrDeps = accepted;
        mod.acceptedHmrExports = acceptedExports;
        mod.importedBindings = importedBindings;
        mod.staticImportedUrls = staticImportedUrls;
        return noLongerImported;
    }

    /** With `resolved` (import analysis already resolved it), the url maps to that id without resolving again. */
    async ensureEntryFromUrl(rawUrl: string, setIsSelfAccepting = true, resolved?: { id: string; meta?: any }): Promise<EnvironmentModuleNode> {
        const [url, resolvedId, meta] = resolved
            ? [unwrapId(removeImportQuery(removeTimestampQuery(rawUrl))), resolved.id, resolved.meta]
            : await this.resolveUrl(rawUrl);
        let mod = this.idToModuleMap.get(resolvedId);
        if (!mod) {
            mod = new EnvironmentModuleNode(url, this.environment, setIsSelfAccepting);
            if (meta) mod.meta = meta;
            this.urlToModuleMap.set(url, mod);
            mod.id = resolvedId;
            this.idToModuleMap.set(resolvedId, mod);
            const file = (mod.file = cleanUrl(resolvedId));
            let set = this.fileToModulesMap.get(file);
            if (!set) this.fileToModulesMap.set(file, (set = new Set()));
            set.add(mod);
        } else if (!this.urlToModuleMap.has(url)) {
            this.urlToModuleMap.set(url, mod);
        }
        return mod;
    }

    createFileOnlyEntry(file: string): EnvironmentModuleNode {
        file = path.normalize(file);
        let set = this.fileToModulesMap.get(file);
        if (!set) this.fileToModulesMap.set(file, (set = new Set()));
        const url = `/@fs/${file}`;
        for (const m of set) if (m.url === url || m.id === file) return m;
        const mod = new EnvironmentModuleNode(url, this.environment);
        mod.file = file;
        set.add(mod);
        return mod;
    }

    async resolveUrl(url: string): Promise<[string, string, Record<string, any> | undefined]> {
        url = unwrapId(removeImportQuery(removeTimestampQuery(url)));
        const mod = this.urlToModuleMap.get(url);
        if (mod?.id) return [mod.url, mod.id, mod.meta];
        const resolved = await this.resolveId(url);
        const resolvedId = resolved?.id || url;
        if (url !== resolvedId && !url.includes('\0') && !url.startsWith('virtual:')) {
            const ext = path.extname(cleanUrl(resolvedId));
            if (ext) {
                const pathname = cleanUrl(url);
                if (!pathname.endsWith(ext)) url = pathname + ext + url.slice(pathname.length);
            }
        }
        return [url, resolvedId, resolved?.meta];
    }
}

/** A module seen from both environments, the shape `server.moduleGraph` hands out. */
export class ModuleNode {
    constructor(private graph: ModuleGraph, public _clientModule?: EnvironmentModuleNode, public _ssrModule?: EnvironmentModuleNode) {}
    private get primary(): EnvironmentModuleNode {
        return (this._clientModule ?? this._ssrModule)!;
    }
    get url() { return this.primary.url; }
    get id() { return this.primary.id; }
    get file() { return this.primary.file; }
    get type() { return this.primary.type; }
    get info() { return this.primary.info; }
    get meta() { return this.primary.meta; }
    get isSelfAccepting() { return this._clientModule?.isSelfAccepting; }
    get transformResult() { return this._clientModule?.transformResult ?? null; }
    get ssrTransformResult() { return this._ssrModule?.transformResult ?? null; }
    get ssrModule() { return this._ssrModule?.ssrModule ?? null; }
    get ssrError() { return this._ssrModule?.ssrError ?? null; }
    get lastHMRTimestamp() { return Math.max(this._clientModule?.lastHMRTimestamp ?? 0, this._ssrModule?.lastHMRTimestamp ?? 0); }
    get lastInvalidationTimestamp() { return Math.max(this._clientModule?.lastInvalidationTimestamp ?? 0, this._ssrModule?.lastInvalidationTimestamp ?? 0); }
    private wrapSet(a?: Set<EnvironmentModuleNode>, b?: Set<EnvironmentModuleNode>): Set<ModuleNode> {
        const out = new Set<ModuleNode>();
        for (const m of a ?? []) out.add(this.graph.wrap(m));
        for (const m of b ?? []) out.add(this.graph.wrap(m));
        return out;
    }
    get importers() { return this.wrapSet(this._clientModule?.importers, this._ssrModule?.importers); }
    get clientImportedModules() { return this.wrapSet(this._clientModule?.importedModules); }
    get ssrImportedModules() { return this.wrapSet(this._ssrModule?.importedModules); }
    get importedModules() { return this.wrapSet(this._clientModule?.importedModules, this._ssrModule?.importedModules); }
    get acceptedHmrDeps() { return this.wrapSet(this._clientModule?.acceptedHmrDeps); }
}

export class ModuleGraph {
    private cache = new WeakMap<EnvironmentModuleNode, ModuleNode>();

    constructor(private client: () => EnvironmentModuleGraph, private ssr: () => EnvironmentModuleGraph) {}

    /** Wrap one environment's node, pairing it with its twin in the other graph. */
    wrap(mod: EnvironmentModuleNode): ModuleNode {
        let node = this.cache.get(mod);
        if (node) return node;
        const other = mod.id ? (mod.environment === 'client' ? this.ssr() : this.client()).getModuleById(mod.id) : undefined;
        node = mod.environment === 'client' ? new ModuleNode(this, mod, other) : new ModuleNode(this, other, mod);
        this.cache.set(mod, node);
        if (other) this.cache.set(other, node);
        return node;
    }

    private pick(client?: EnvironmentModuleNode, ssr?: EnvironmentModuleNode): ModuleNode | undefined {
        const mod = client ?? ssr;
        if (!mod) return undefined;
        const node = this.wrap(mod);
        if (client && !node._clientModule) node._clientModule = client;
        if (ssr && !node._ssrModule) node._ssrModule = ssr;
        return node;
    }

    async getModuleByUrl(url: string, ssr?: boolean): Promise<ModuleNode | undefined> {
        const [c, s] = await Promise.all([this.client().getModuleByUrl(url), this.ssr().getModuleByUrl(url)]);
        return ssr ? this.pick(s ? c : c, s) ?? this.pick(c, s) : this.pick(c, s);
    }

    getModuleById(id: string): ModuleNode | undefined {
        return this.pick(this.client().getModuleById(id), this.ssr().getModuleById(id));
    }

    getModulesByFile(file: string): Set<ModuleNode> | undefined {
        const out = new Set<ModuleNode>();
        for (const m of this.client().getModulesByFile(file) ?? []) out.add(this.wrap(m));
        for (const m of this.ssr().getModulesByFile(file) ?? []) out.add(this.wrap(m));
        return out.size ? out : undefined;
    }

    get urlToModuleMap(): Map<string, ModuleNode> {
        const out = new Map<string, ModuleNode>();
        for (const [k, m] of this.client().urlToModuleMap) out.set(k, this.wrap(m));
        for (const [k, m] of this.ssr().urlToModuleMap) if (!out.has(k)) out.set(k, this.wrap(m));
        return out;
    }

    get idToModuleMap(): Map<string, ModuleNode> {
        const out = new Map<string, ModuleNode>();
        for (const [k, m] of this.client().idToModuleMap) out.set(k, this.wrap(m));
        for (const [k, m] of this.ssr().idToModuleMap) if (!out.has(k)) out.set(k, this.wrap(m));
        return out;
    }

    get fileToModulesMap(): Map<string, Set<ModuleNode>> {
        const out = new Map<string, Set<ModuleNode>>();
        for (const graph of [this.client(), this.ssr()]) {
            for (const [file, mods] of graph.fileToModulesMap) {
                const set = out.get(file) ?? new Set<ModuleNode>();
                for (const m of mods) set.add(this.wrap(m));
                out.set(file, set);
            }
        }
        return out;
    }

    onFileChange(file: string): void {
        this.client().onFileChange(file);
        this.ssr().onFileChange(file);
    }

    invalidateModule(mod: ModuleNode, seen = new Set<any>(), timestamp = Date.now(), isHmr = false): void {
        if (mod._clientModule) this.client().invalidateModule(mod._clientModule, new Set(), timestamp, isHmr);
        if (mod._ssrModule) this.ssr().invalidateModule(mod._ssrModule, new Set(), timestamp, isHmr);
        seen.add(mod);
    }

    invalidateAll(): void {
        this.client().invalidateAll();
        this.ssr().invalidateAll();
    }

    async ensureEntryFromUrl(rawUrl: string, ssr?: boolean): Promise<ModuleNode> {
        const mod = await (ssr ? this.ssr() : this.client()).ensureEntryFromUrl(rawUrl);
        return this.wrap(mod);
    }

    createFileOnlyEntry(file: string): ModuleNode {
        return this.wrap(this.client().createFileOnlyEntry(file));
    }

    async resolveUrl(url: string, ssr?: boolean): Promise<[string, string, Record<string, any> | undefined]> {
        return (ssr ? this.ssr() : this.client()).resolveUrl(url);
    }
}
