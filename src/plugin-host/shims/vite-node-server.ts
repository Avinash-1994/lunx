/**
 * `vite-node/server`: serves modules to a module runner (React Router loads
 * its route config through it; Nuxt renders pages in its Nitro worker with
 * it). Built on lunx's SSR pipeline: dependencies Node can run natively are
 * externalized, everything else is transformed by the plugin host.
 */

import { builtinModules } from 'node:module';
import path from 'node:path';
import { shouldExternalize } from '../plugins/resolve.js';
import { cleanUrl } from '../utils.js';

export interface FetchResult {
    code?: string;
    externalize?: string;
    map?: any;
}

const builtins = new Set(builtinModules);

/** The package name a node_modules file belongs to. */
function packageNameOf(file: string): string | null {
    const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(file.slice(file.lastIndexOf('node_modules') - 1));
    return m ? m[1]!.replace(/\\/g, '/') : null;
}

export class ViteNodeServer {
    readonly fetchCache = new Map<string, { timestamp: number; result: FetchResult }>();

    constructor(public server: any, public options: Record<string, any> = {}) {}

    private get ssr(): any {
        return this.server.environments?.ssr;
    }

    /** A path or bare id Node can import natively, or false to transform it. */
    async shouldExternalize(id: string): Promise<string | false> {
        const file = cleanUrl(id);
        if (id.startsWith('node:') || builtins.has(id)) return id;
        if (/^(data|https?):/.test(id)) return id;
        if (!/[\\/]node_modules[\\/]/.test(file) || !/\.(m|c)?js$/.test(file)) return false;
        const inline = this.options.deps?.inline;
        if (inline === true) return false;
        const pkg = packageNameOf(file);
        if (!pkg) return false;
        if (Array.isArray(inline) && inline.some((p: string | RegExp) => (typeof p === 'string' ? file.includes(p) : p.test(file)))) return false;
        return shouldExternalize(this.ssr.config, pkg, file) ? file : false;
    }

    async resolveId(id: string, importer?: string): Promise<{ id: string; external?: boolean } | null> {
        if (importer && !path.isAbsolute(importer) && !importer.startsWith('\0')) importer = path.join(this.server.config.root, importer);
        const resolved = await this.ssr.pluginContainer.resolveId(id, importer);
        return resolved ? { id: resolved.id, external: !!resolved.external } : null;
    }

    async fetchModule(id: string, _transformMode?: string): Promise<FetchResult> {
        const external = await this.shouldExternalize(id);
        if (external) return { externalize: external };
        const result = await this.ssr.transformRequest(id);
        if (!result) throw new Error(`[lunx] failed to load ${id}`);
        return { code: result.code, map: result.map ?? null };
    }

    async transformRequest(id: string, _filepath?: string, transformMode?: string): Promise<any> {
        return transformMode === 'web' ? this.server.environments.client.transformRequest(id) : this.ssr.transformRequest(id);
    }

    getSourceMap(_source: string): null {
        return null;
    }

    async transformModule(id: string, transformMode?: string): Promise<any> {
        return this.transformRequest(id, undefined, transformMode);
    }
}

export default { ViteNodeServer };
