/**
 * The last transform of every module (Vite's vite:import-analysis): resolve
 * each import, rewrite it to the URL the dev server serves it at (or keep it
 * bare when the server environment externalizes it), inject
 * `import.meta.hot` / `import.meta.env` for the browser, record HMR
 * boundaries and update the module graph.
 */

import path from 'node:path';
import { parse } from '../../engines/index.js';
import { MagicString } from '../../engines/toolkit.js';
import { full as walk } from '../../lib/ast-walk.js';
import { globImports } from './index.js';
import { shouldExternalize } from './resolve.js';
import {
    CLIENT_PUBLIC_PATH,
    cleanUrl,
    FS_PREFIX,
    injectQuery,
    isCSSRequest,
    isDataUrl,
    isExternalUrl,
    isJSRequest,
    normalizePath,
    removeImportQuery,
    removeTimestampQuery,
    unwrapId,
    wrapId,
} from '../utils.js';

const SKIP_RE = /\.(?:map|json)$|[?&](?:raw|url|worker|sharedworker)\b/;

export function idToUrl(config: any, id: string): string {
    const qi = id.search(/[?#]/);
    const file = qi === -1 ? id : id.slice(0, qi);
    const query = qi === -1 ? '' : id.slice(qi);
    if (id.startsWith('\0') || (!path.isAbsolute(file) && !/^[A-Za-z]:[\\/]/.test(file))) return wrapId(id);
    const rel = path.relative(config.root, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return '/' + normalizePath(rel) + query;
    return FS_PREFIX + normalizePath(file).replace(/^\//, '') + query;
}

interface ImportSite {
    start: number;
    end: number;
    spec: string;
    dynamic: boolean;
}

function literalValue(node: any): string | null {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
    return null;
}

function isHotMember(node: any, method: string): boolean {
    return (
        node?.type === 'MemberExpression' &&
        !node.computed &&
        node.property?.name === method &&
        node.object?.type === 'MemberExpression' &&
        node.object.property?.name === 'hot' &&
        node.object.object?.type === 'MetaProperty'
    );
}

/**
 * The injected `import.meta.env` object, as Vite's serializeDefine writes it:
 * env values as JSON, `define` entries for `import.meta.env.X` as the code
 * they are (vinxi defines MANIFEST as `globalThis.MANIFEST`).
 */
function envObjectCode(config: any, env: any): string {
    const entries = new Map<string, string>();
    for (const [key, value] of Object.entries({ ...config.env, SSR: false })) entries.set(key, JSON.stringify(value));
    for (const [key, value] of Object.entries({ ...config.define, ...env.config.define })) {
        if (!key.startsWith('import.meta.env.')) continue;
        entries.set(key.slice('import.meta.env.'.length), typeof value === 'string' ? value : JSON.stringify(value));
    }
    return `{${[...entries].map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(', ')}}`;
}

export function importAnalysisPlugin(config: any): any {
    return {
        name: 'vite:import-analysis',
        async transform(this: any, source: string, importer: string) {
            if (SKIP_RE.test(importer) && !importer.endsWith('.json')) return null;
            if (isCSSRequest(importer) && /[?&]direct\b/.test(importer)) return null;
            const env = this.environment;
            const isClient = env.config.consumer === 'client';
            const file = cleanUrl(importer);
            const original = source;

            // As Vite's client-inject: `process.env.NODE_ENV` is replaced, not defined as a global.
            if (isClient && source.includes('process.env.NODE_ENV')) {
                source = source.replace(/\bprocess\.env\.NODE_ENV\b(?!\s*=[^=])/g, JSON.stringify(process.env.NODE_ENV || (config.isProduction ? 'production' : 'development')));
            }
            if (source.includes('import.meta.glob')) {
                source = globImports(source, importer, config.root) ?? source;
            }
            if (!/\bimport\b|\bexport\b/.test(source)) return source === original ? null : { code: source, map: null };

            let ast: any;
            try {
                ast = parse(file.endsWith('.js') || file.endsWith('.mjs') ? file : 'module.js', source, 'js');
            } catch (err: any) {
                if (/\.(json|css)$/.test(file)) return null;
                err.message = `Failed to parse source for import analysis: ${err.message}`;
                err.id = importer;
                throw err;
            }

            const sites: ImportSite[] = [];
            const acceptSites: Array<{ start: number; end: number; spec: string }> = [];
            let isSelfAccepting = false;
            walk(ast, (node: any) => {
                switch (node.type) {
                    case 'ImportDeclaration':
                    case 'ExportNamedDeclaration':
                    case 'ExportAllDeclaration': {
                        if (node.importKind === 'type' || node.exportKind === 'type') return;
                        const spec = literalValue(node.source);
                        if (spec != null) sites.push({ start: node.source.start, end: node.source.end, spec, dynamic: false });
                        return;
                    }
                    case 'ImportExpression': {
                        const spec = literalValue(node.source);
                        if (spec != null) sites.push({ start: node.source.start, end: node.source.end, spec, dynamic: true });
                        return;
                    }
                    case 'CallExpression': {
                        if (!isClient) return;
                        if (isHotMember(node.callee, 'accept')) {
                            const arg = node.arguments[0];
                            if (!arg || arg.type.includes('Function')) isSelfAccepting = true;
                            else if (literalValue(arg) != null) acceptSites.push({ start: arg.start, end: arg.end, spec: literalValue(arg)! });
                            else if (arg.type === 'ArrayExpression') {
                                for (const el of arg.elements) {
                                    const v = literalValue(el);
                                    if (v != null) acceptSites.push({ start: el.start, end: el.end, spec: v });
                                }
                            }
                        } else if (isHotMember(node.callee, 'acceptExports')) {
                            isSelfAccepting = true;
                        }
                        return;
                    }
                }
            });

            const s = new MagicString(source);
            // Served URLs carry the base (/_nuxt/@vite/client under Nuxt).
            const withBase = (url: string) => (config.base !== '/' && config.base !== './' && url.startsWith('/') ? config.base.replace(/\/$/, '') + url : url);
            const importedUrls = new Set<string>();
            const staticImportedUrls = new Set<string>();
            const graph = env.moduleGraph;

            const normalize = async (spec: string): Promise<{ url: string; hmrUrl: string } | null> => {
                // file:// imports resolve like paths (plugin-rsc imports its runtime that way); only remote URLs stay.
                if ((isExternalUrl(spec) && !spec.startsWith('file://')) || isDataUrl(spec)) return null;
                if (spec === CLIENT_PUBLIC_PATH || spec.startsWith('/@vite/')) return { url: withBase(spec), hmrUrl: spec };
                const resolved = await this.resolve(spec, importer, { skipSelf: false });
                if (!resolved) {
                    if (!isClient) return null;
                    const rel = path.relative(config.root, file);
                    const err: any = new Error(`Failed to resolve import "${spec}" from "${rel.startsWith('..') ? file : rel}". Does the file exist?`);
                    err.id = importer;
                    err.plugin = 'vite:import-analysis';
                    throw err;
                }
                if (resolved.external) return null;
                // Dev SSR externalization (Vite's rule): plain-JS dependencies run natively in Node.
                if (!isClient && /^[\w@]/.test(spec) && !spec.startsWith('#') && shouldExternalize(env.config, spec, resolved.id)) return null;
                const optimizer = env.depsOptimizer;
                // As Vite: imports inside node_modules never discover new dependencies (an excluded
                // package's own imports stay raw so framework transforms still run on them).
                const known = optimizer?.lookup(spec, resolved.id);
                const depName = known ?? spec;
                const discoverable = !!known || !/[\\/]node_modules[\\/]/.test(file);
                if (optimizer && discoverable && (known || /^[\w@]/.test(spec)) && !optimizer.isOptimizedFile(file) && optimizer.shouldOptimize(depName, resolved.id)) {
                    const url = await optimizer.urlFor(depName, resolved.id);
                    return { url: isClient ? withBase(url) : url, hmrUrl: url.replace(/\?.*$/, '') };
                }
                let url = idToUrl(config, resolved.id);
                const hmrUrl = unwrapId(removeImportQuery(removeTimestampQuery(url)));
                // Imports between pre-bundled files carry the same ?v= as imports into them, or one
                // dependency loads twice (Rolldown links sibling entries directly: ./solid-js.js).
                if (optimizer?.version && optimizer.isOptimizedFile(cleanUrl(resolved.id)) && !/[?&]v=/.test(url)) url = injectQuery(url, `v=${optimizer.version}`);
                if (isClient) {
                    if (!isJSRequest(url) && !isCSSRequest(url)) url = injectQuery(url, 'import');
                    const dep = graph.getModuleById(resolved.id);
                    if (dep?.lastHMRTimestamp > 0) url = injectQuery(url, `t=${dep.lastHMRTimestamp}`);
                    if (config.base !== '/' && config.base !== './' && url.startsWith('/')) url = config.base.replace(/\/$/, '') + url;
                }
                return { url, hmrUrl };
            };

            for (const site of sites) {
                const normalized = await normalize(site.spec);
                if (!normalized) continue;
                s.overwrite(site.start, site.end, JSON.stringify(normalized.url));
                importedUrls.add(normalized.hmrUrl);
                if (!site.dynamic) staticImportedUrls.add(normalized.hmrUrl);
            }

            const acceptedUrls = new Set<string>();
            for (const site of acceptSites) {
                const normalized = await normalize(site.spec);
                if (!normalized) continue;
                s.overwrite(site.start, site.end, JSON.stringify(normalized.hmrUrl));
                acceptedUrls.add(normalized.hmrUrl);
            }

            const mod = graph.getModuleById(importer);
            if (isClient) {
                if (source.includes('import.meta.env')) {
                    s.prepend(`import.meta.env = ${envObjectCode(config, env)};`);
                }
                if (source.includes('import.meta.hot')) {
                    const ownUrl = mod?.url ?? idToUrl(config, importer);
                    s.prepend(`import { createHotContext as __vite__createHotContext } from "${withBase(CLIENT_PUBLIC_PATH)}";import.meta.hot = __vite__createHotContext(${JSON.stringify(ownUrl)});`);
                }
            }

            if (mod) {
                const imported = new Set<string>([...importedUrls].filter((u) => !u.startsWith('/@vite/')));
                await graph.updateModuleInfo(mod, imported, null, acceptedUrls, null, isSelfAccepting, staticImportedUrls);
            }
            return { code: s.toString(), map: null };
        },
    };
}
