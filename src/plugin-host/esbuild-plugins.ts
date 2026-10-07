/**
 * esbuild plugins on Rolldown. Vite 5–7 plugins hand the dependency
 * optimizer esbuild plugins through `optimizeDeps.esbuildOptions.plugins`
 * (Angular's linker, Svelte's and Vue's dependency compilers, polyfills…).
 * This runs their `setup(build)` against a recording `build` object and
 * replays the `onResolve` / `onLoad` / `onStart` / `onEnd` callbacks as
 * Rolldown hooks. Non-`file` namespaces become `\0esbuild:<ns>:<path>` ids.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createResolver } from '../engines/toolkit.js';

interface Callback {
    filter: RegExp;
    namespace?: string;
    fn: (args: any) => any;
}

const PREFIX = '\0esbuild:';

function encode(namespace: string, p: string): string {
    return namespace === 'file' ? p : `${PREFIX}${namespace}:${p}`;
}

function decode(id: string): { namespace: string; path: string } {
    if (!id.startsWith(PREFIX)) return { namespace: 'file', path: id };
    const rest = id.slice(PREFIX.length);
    const i = rest.indexOf(':');
    return { namespace: rest.slice(0, i), path: rest.slice(i + 1) };
}

/** esbuild loader → Rolldown module type / generated module. */
function loaded(contents: string | Uint8Array, loader: string | undefined, file: string): { code: string; moduleType: string } {
    const text = typeof contents === 'string' ? contents : Buffer.from(contents).toString('utf8');
    const ext = loader ?? (path.extname(file).slice(1) || 'js');
    switch (ext) {
        case 'js': case 'mjs': case 'cjs': return { code: text, moduleType: 'js' };
        case 'jsx': case 'ts': case 'tsx': case 'json': case 'css': return { code: text, moduleType: ext };
        case 'text': return { code: `export default ${JSON.stringify(text)};`, moduleType: 'js' };
        case 'base64': return { code: `export default ${JSON.stringify(Buffer.from(contents as any).toString('base64'))};`, moduleType: 'js' };
        case 'dataurl': return { code: `export default ${JSON.stringify(`data:application/octet-stream;base64,${Buffer.from(contents as any).toString('base64')}`)};`, moduleType: 'js' };
        case 'binary': return { code: `export default Uint8Array.from(atob(${JSON.stringify(Buffer.from(contents as any).toString('base64'))}), (c) => c.charCodeAt(0));`, moduleType: 'js' };
        case 'empty': return { code: 'export {};', moduleType: 'js' };
        default: return { code: text, moduleType: 'js' };
    }
}

export function esbuildPluginsToRolldown(plugins: any[], options: { root: string; platform: 'browser' | 'node'; conditions?: string[] }): any[] {
    return plugins.filter((p) => p && typeof p.setup === 'function').map((plugin) => adapt(plugin, options));
}

function adapt(plugin: any, options: { root: string; platform: 'browser' | 'node'; conditions?: string[] }): any {
    const onResolve: Callback[] = [];
    const onLoad: Callback[] = [];
    const onStart: Array<() => any> = [];
    const onEnd: Array<(result: any) => any> = [];
    const pluginData = new Map<string, unknown>();
    /** `resolveDir` an onLoad gave a namespaced module: where its relative imports resolve from. */
    const resolveDirs = new Map<string, string>();
    const resolver = createResolver({
        conditionNames: [...(options.conditions ?? []), options.platform === 'browser' ? 'browser' : 'node', 'import', 'module', 'default'],
        mainFields: options.platform === 'browser' ? ['browser', 'module', 'main'] : ['module', 'main'],
        extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json', '.css'],
    });
    const build = {
        initialOptions: { platform: options.platform, absWorkingDir: options.root, bundle: true, format: 'esm', plugins: [] },
        esbuild: { version: '0.25.0' },
        onResolve: (opts: any, fn: any) => onResolve.push({ filter: opts.filter, namespace: opts.namespace, fn }),
        onLoad: (opts: any, fn: any) => onLoad.push({ filter: opts.filter, namespace: opts.namespace, fn }),
        onStart: (fn: any) => onStart.push(fn),
        onEnd: (fn: any) => onEnd.push(fn),
        onDispose: () => {},
        async resolve(spec: string, opts: { resolveDir?: string; importer?: string } = {}) {
            const dir = opts.resolveDir ?? (opts.importer ? path.dirname(opts.importer) : options.root);
            const found = path.isAbsolute(spec) && fs.existsSync(spec) ? spec : resolver.resolve(dir, spec);
            return found
                ? { path: found, namespace: 'file', external: false, errors: [], warnings: [], sideEffects: true, suffix: '', pluginData: undefined }
                : { path: '', namespace: '', external: false, errors: [{ text: `Could not resolve "${spec}"` }], warnings: [], sideEffects: true, suffix: '', pluginData: undefined };
        },
    };
    const ready = Promise.resolve(plugin.setup(build));
    const matches = (cb: Callback, p: string, namespace: string) => (cb.namespace ?? 'file') === namespace && cb.filter.test(p);

    return {
        name: `esbuild:${plugin.name ?? 'plugin'}`,
        async buildStart() {
            await ready;
            for (const fn of onStart) await fn();
        },
        async resolveId(this: any, id: string, importer: string | undefined, extra: any) {
            await ready;
            const from = importer ? decode(importer) : { namespace: 'file', path: '' };
            for (const cb of onResolve) {
                if (!cb.filter.test(id) || (cb.namespace && cb.namespace !== from.namespace && !(cb.namespace === 'file' && !importer))) continue;
                const result = await cb.fn({
                    path: id,
                    importer: from.path,
                    namespace: from.namespace,
                    resolveDir: from.namespace === 'file' && from.path ? path.dirname(from.path) : options.root,
                    kind: extra?.kind === 'dynamic-import' ? 'dynamic-import' : extra?.kind === 'require-call' ? 'require-call' : importer ? 'import-statement' : 'entry-point',
                    pluginData: importer ? pluginData.get(importer) : undefined,
                    with: {},
                });
                if (!result) continue;
                if (result.errors?.length) this.error(result.errors[0].text ?? String(result.errors[0]));
                if (!result.path && !result.namespace) continue;
                const resolved = encode(result.namespace ?? 'file', result.path ?? id);
                if (result.pluginData !== undefined) pluginData.set(resolved, result.pluginData);
                return { id: resolved, external: !!result.external, moduleSideEffects: result.sideEffects === false ? false : undefined };
            }
            // A relative import inside a namespaced module: from the onLoad's resolveDir, as esbuild does.
            if (importer && resolveDirs.has(importer) && /^\.{1,2}\//.test(id)) {
                const found = resolver.resolve(resolveDirs.get(importer)!, id);
                if (found) return { id: found };
            }
            return null;
        },
        async load(id: string) {
            await ready;
            const { namespace, path: p } = decode(id.startsWith(PREFIX) ? id : id.split('?')[0]!);
            for (const cb of onLoad) {
                if (!matches(cb, p, namespace)) continue;
                const result = await cb.fn({ path: p, namespace, suffix: '', pluginData: pluginData.get(id), with: {} });
                if (!result || result.contents === undefined) continue;
                if (result.pluginData !== undefined) pluginData.set(id, result.pluginData);
                resolveDirs.set(id, result.resolveDir ?? (namespace === 'file' ? path.dirname(p) : options.root));
                return loaded(result.contents, result.loader, p);
            }
            return null;
        },
        async buildEnd(error?: Error) {
            for (const fn of onEnd) await fn({ errors: error ? [{ text: error.message }] : [], warnings: [] });
        },
    };
}
