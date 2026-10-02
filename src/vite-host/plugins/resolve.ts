/**
 * Module resolution in Vite's shape: root-relative URLs, /@fs/ paths,
 * relative and bare imports (package `exports`, `browser`, per-environment
 * conditions), and SSR externalization of dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createResolver, type ModuleResolver } from '../../engines/toolkit.js';
import { arraify, bareImportRE, cleanUrl, FS_PREFIX, fsPathFromId, isBuiltin, isDataUrl, isExternalUrl } from '../utils.js';

export const BROWSER_EXTERNAL_ID = '__vite-browser-external';

function splitQuery(id: string): [string, string] {
    const i = id.search(/[?#]/);
    return i === -1 ? [id, ''] : [id.slice(0, i), id.slice(i)];
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

export function getPackageName(spec: string): string {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

function matches(list: unknown, spec: string, pkg: string): boolean {
    for (const pattern of arraify(list as any)) {
        if (typeof pattern === 'string' && (pattern === pkg || pattern === spec)) return true;
        if (pattern instanceof RegExp) {
            pattern.lastIndex = 0;
            if (pattern.test(spec)) return true;
        }
    }
    return false;
}

/** Vite's rule: plain-JS dependencies in node_modules run natively in Node. */
export function shouldExternalize(envConfig: any, spec: string, resolved: string | null): boolean {
    if (isBuiltin(spec)) return true;
    const { noExternal, external } = envConfig.resolve ?? {};
    if (noExternal === true) return false;
    const pkg = getPackageName(spec);
    if (matches(noExternal, spec, pkg)) return false;
    if (external === true || matches(external, spec, pkg)) return true;
    if (!resolved) return true;
    if (!resolved.includes(`${path.sep}node_modules${path.sep}`) && !resolved.includes('/node_modules/')) return false;
    return /\.(m|c)?js$/.test(resolved) || resolved.endsWith('.json') || resolved.endsWith('.node');
}

export function resolvePlugin(config: any): any {
    const resolvers = new Map<string, ModuleResolver>();
    const resolverFor = (env: any): ModuleResolver => {
        const isClient = env.config.consumer === 'client';
        const r = env.config.resolve ?? config.resolve;
        const key = `${isClient}|${r.conditions.join(',')}|${r.mainFields.join(',')}|${r.extensions.join(',')}`;
        let resolver = resolvers.get(key);
        if (!resolver) {
            resolver = createResolver({
                conditionNames: [...r.conditions, 'import', 'default'],
                mainFields: [...r.mainFields, 'main'],
                extensions: r.extensions,
                aliasFields: isClient ? [['browser']] : undefined,
                symlinks: !r.preserveSymlinks,
            });
            resolvers.set(key, resolver);
        }
        return resolver;
    };

    const tryFs = (resolver: ModuleResolver, file: string): string | null => {
        if (isFile(file)) return safeRealpath(file, config);
        return resolver.resolve(path.dirname(file), file);
    };

    return {
        name: 'vite:resolve',
        async resolveId(this: any, id: string, importer: string | undefined) {
            if (id.startsWith('\0') || id.startsWith('virtual:') || id.startsWith('/virtual:')) return null;
            if (id.startsWith(BROWSER_EXTERNAL_ID)) return id;
            const env = this.environment;
            const isClient = env.config.consumer === 'client';
            const root = config.root;
            const resolver = resolverFor(env);
            const [file, query] = splitQuery(id);

            if (isExternalUrl(id)) return { id, external: true };
            if (isDataUrl(id)) return null;

            if (file.startsWith(FS_PREFIX)) {
                const fsPath = fsPathFromId(file);
                const found = tryFs(resolver, fsPath);
                return (found ?? fsPath) + query;
            }

            if (file.startsWith('/')) {
                // A root-relative URL first, then an absolute file system path.
                const inRoot = path.join(root, file);
                const found = tryFs(resolver, inRoot);
                if (found) return found + query;
                if (path.isAbsolute(file) && (isFile(file) || fs.existsSync(path.dirname(file)))) {
                    const abs = tryFs(resolver, file);
                    if (abs) return abs + query;
                }
                return null;
            }

            const importerFile = importer && !importer.startsWith('\0') && path.isAbsolute(cleanUrl(importer)) ? cleanUrl(importer) : path.join(root, 'index.html');
            const basedir = path.dirname(importerFile);

            if (file.startsWith('.')) {
                const found = tryFs(resolver, path.resolve(basedir, file));
                return found ? found + query : null;
            }

            if (/^[A-Za-z]:[\\/]/.test(file)) {
                const found = tryFs(resolver, file);
                return found ? found + query : null;
            }

            if (bareImportRE.test(file) || isBuiltin(file)) {
                if (isBuiltin(file)) {
                    if (!isClient) return { id: file, external: true };
                    return `${BROWSER_EXTERNAL_ID}:${file}`;
                }
                const resolved = resolver.resolve(basedir, file) ?? resolver.resolve(root, file);
                if (!isClient && shouldExternalize(env.config, file, resolved)) return { id: file, external: true };
                if (!resolved) return null;
                return resolved + query;
            }
            return null;
        },
        load(id: string) {
            if (!id.startsWith(BROWSER_EXTERNAL_ID)) return null;
            const name = id.slice(BROWSER_EXTERNAL_ID.length + 1);
            return `export default new Proxy({}, { get(_, key) { if (typeof key === 'symbol' || key === '__esModule') return undefined; throw new Error(\`Module "${name}" has been externalized for browser compatibility. Cannot access "${name}.\${String(key)}" in client code.\`) } })`;
        },
    };
}

function safeRealpath(file: string, config: any): string {
    if (config.resolve.preserveSymlinks) return file;
    try {
        return fs.realpathSync(file);
    } catch {
        return file;
    }
}
