/**
 * lunx's built-in plugins, in the slots Vite gives its own: alias, resolve,
 * css, oxc (TS/JSX), json, asset, define, css-post and import-analysis.
 */

import fs from 'node:fs';
import path from 'node:path';
import { compile } from '../../engines/index.js';
import { assetPlugin } from './asset.js';
import { assetBuildPlugin, BuildState, cssBuildPlugins, manifestPlugin } from './build.js';
import { transformGlobImports } from '../../build/glob-import.js';
import { cssPlugin, cssPostPlugin } from './css.js';
import { importAnalysisPlugin } from './import-analysis.js';
import { resolvePlugin } from './resolve.js';
import { cleanUrl } from '../utils.js';

const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url|inline)\b/;

export function corePlugins(config: any, user: { pre: any[]; normal: any[]; post: any[] }): any[] {
    if (config.command === 'build') {
        // One BuildState per environment: a builder (createBuilder) builds several with these plugins.
        const states = new Map<string, BuildState>();
        config._lunxBuildStates = states;
        const getState = (ctx: any): BuildState => {
            const env = ctx?.environment;
            const name = env?.name ?? (config.build.ssr ? 'ssr' : 'client');
            let state = states.get(name);
            if (!state) {
                const build = env?.config?.build ?? config.build;
                const output = [].concat(build.rollupOptions?.output ?? {})[0] as any;
                const ssr = env ? env.config.consumer === 'server' || !!build.ssr : !!config.build.ssr;
                states.set(name, (state = new BuildState(config, ssr, output?.assetFileNames, build)));
            }
            return state;
        };
        const [css, cssPost] = cssBuildPlugins(getState);
        return [
            aliasPlugin(config),
            ...user.pre,
            resolvePlugin(config),
            css,
            oxcPlugin(config),
            jsonPlugin(config),
            assetBuildPlugin(getState),
            globImportPlugin(config),
            ...user.normal,
            cssPost,
            ...user.post,
            manifestPlugin(getState),
            loadFallbackPlugin(),
        ];
    }
    return [
        aliasPlugin(config),
        ...user.pre,
        resolvePlugin(config),
        cssPlugin(config),
        oxcPlugin(config),
        jsonPlugin(config),
        assetPlugin(config),
        ...user.normal,
        definePlugin(config),
        cssPostPlugin(config),
        ...user.post,
        importAnalysisPlugin(config),
    ];
}

/** resolve.alias: rewrite, then resolve the result with the remaining plugins. */
function aliasPlugin(config: any): any {
    return {
        name: 'vite:pre-alias',
        async resolveId(this: any, id: string, importer: string | undefined, options: any) {
            const entries = this.environment.config.resolve?.alias ?? config.resolve.alias;
            for (const entry of entries) {
                const { find, replacement } = entry;
                let updated: string | null = null;
                if (find instanceof RegExp) {
                    find.lastIndex = 0;
                    if (find.test(id)) updated = id.replace(find, replacement);
                } else if (id === find || id.startsWith(find + '/')) {
                    updated = replacement + id.slice(find.length);
                }
                if (updated == null || updated === id) continue;
                const resolved = await this.resolve(updated, importer, { ...options, skipSelf: true });
                return resolved ?? updated;
            }
            return null;
        },
    };
}

let tsconfigCache = new Map<string, any>();

function readTsconfig(root: string): any {
    if (tsconfigCache.has(root)) return tsconfigCache.get(root);
    let options: any = {};
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
        try {
            const raw = fs.readFileSync(path.join(root, name), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/(^|[^:"'])\/\/.*$/gm, '$1')
                .replace(/,(\s*[}\]])/g, '$1');
            options = JSON.parse(raw).compilerOptions ?? {};
            break;
        } catch {
            /* none or unparsable */
        }
    }
    tsconfigCache.set(root, options);
    return options;
}

export function resetTsconfigCache(): void {
    tsconfigCache = new Map();
}

/** TypeScript and JSX, compiled by Oxc (Vite's esbuild / oxc plugin). */
function oxcPlugin(config: any): any {
    if (config.oxc === false && config.esbuild === false) return { name: 'vite:oxc' };
    return {
        name: 'vite:oxc',
        transform: {
            filter: { id: /\.(m?ts|[jt]sx)(?:$|\?)/ },
            handler(this: any, code: string, id: string) {
                const file = cleanUrl(id);
                if (SPECIAL_QUERY_RE.test(id)) return null;
                // The language is the file's, or the virtual module's (`page.astro?…&lang.ts`), as in Vite.
                const ext = /\.(m?ts|[jt]sx|cts)$/.exec(file)?.[1] ?? /\.(m?ts|[jt]sx)$/.exec(id)?.[1];
                if (!ext) return null;
                const lang = ext === 'tsx' ? 'tsx' : ext === 'jsx' ? 'jsx' : 'ts';
                const ts = readTsconfig(config.root);
                const oxcJsx = config.oxc?.jsx;
                const esb = config.esbuild || {};
                const isClient = this.environment.config.consumer === 'client';
                let jsx: any;
                if (oxcJsx === 'preserve' || esb.jsx === 'preserve') jsx = 'preserve';
                else {
                    const automatic = typeof oxcJsx === 'object'
                        ? oxcJsx.runtime !== 'classic'
                        : esb.jsx ? esb.jsx === 'automatic' : !ts.jsx || /react-jsx/.test(String(ts.jsx));
                    jsx = {
                        runtime: automatic ? 'automatic' : 'classic',
                        importSource: (typeof oxcJsx === 'object' && oxcJsx.importSource) || esb.jsxImportSource || ts.jsxImportSource,
                        pragma: (typeof oxcJsx === 'object' && oxcJsx.pragma) || esb.jsxFactory || ts.jsxFactory,
                        pragmaFrag: (typeof oxcJsx === 'object' && oxcJsx.pragmaFrag) || esb.jsxFragment || ts.jsxFragmentFactory,
                        development: typeof oxcJsx === 'object' && oxcJsx.development !== undefined ? oxcJsx.development : !config.isProduction,
                        refresh: isClient && !file.includes('node_modules') && typeof oxcJsx === 'object' && !!oxcJsx.refresh,
                    };
                }
                const result = compile(file, code, {
                    lang,
                    jsx,
                    legacyDecorators: !!ts.experimentalDecorators,
                    decoratorMetadata: !!ts.emitDecoratorMetadata,
                    sourcemap: false,
                });
                return { code: result.code, map: null, moduleType: 'js' };
            },
        },
    };
}

/** Vite's load fallback: a file id with a query (`route.jsx?client-route`) loads the file itself. */
function loadFallbackPlugin(): any {
    const types: Record<string, string> = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.json': 'json' };
    return {
        name: 'vite:load-fallback',
        load(id: string) {
            const file = cleanUrl(id);
            if (file === id || id.startsWith('\0') || !path.isAbsolute(file) || !fs.existsSync(file)) return null;
            return { code: fs.readFileSync(file, 'utf-8'), moduleType: types[path.extname(file)] ?? 'js' };
        },
    };
}

/** `import.meta.glob` in builds (dev handles it in import analysis). */
function globImportPlugin(config: any): any {
    return {
        name: 'vite:import-glob',
        transform: {
            filter: { code: 'import.meta.glob' },
            handler(code: string, id: string) {
                const file = cleanUrl(id);
                // Dependencies ship expanded globs; their mentions of import.meta.glob are text.
                if (!path.isAbsolute(file) || /[\\/]node_modules[\\/]/.test(file)) return null;
                const out = transformGlobImports(code, file, config.root);
                return out == null ? null : { code: out, map: null };
            },
        },
    };
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'arguments', 'eval']);

function jsonPlugin(config: any): any {
    return {
        name: 'vite:json',
        transform: {
            filter: { id: /\.json(?:$|\?)/ },
            handler(code: string, id: string) {
                if (!/\.json$/.test(cleanUrl(id)) || SPECIAL_QUERY_RE.test(id) || id.includes('commonjs-proxy')) return null;
                const data = JSON.parse(code.charCodeAt(0) === 0xfeff ? code.slice(1) : code);
                const lines = [`const __json__ = ${JSON.stringify(data)};`, 'export default __json__;'];
                if (config.json?.namedExports !== false && data && typeof data === 'object' && !Array.isArray(data)) {
                    const keys = Object.keys(data).filter((k) => IDENT_RE.test(k) && !RESERVED.has(k));
                    if (keys.length) lines.push(`export const { ${keys.join(', ')} } = __json__;`);
                }
                return { code: lines.join('\n'), map: null, moduleType: 'js' };
            },
        },
    };
}

/**
 * `define` and `import.meta.env.*` for the server environment. The client
 * gets defines as globals from /@vite/env and `import.meta.env` injected by
 * import analysis, as in Vite.
 */
function definePlugin(config: any): any {
    return {
        name: 'vite:define',
        transform(this: any, code: string, id: string) {
            if (this.environment.config.consumer === 'client') return null;
            const file = cleanUrl(id);
            if (!/\.(m?[jt]sx?|cjs|svelte|vue|astro)$/.test(file) && !id.startsWith('\0') && path.extname(file)) return null;
            const define: Record<string, string> = {};
            const userDefine = { ...config.define, ...this.environment.config.define };
            for (const [key, value] of Object.entries(userDefine)) {
                if (code.includes(key)) define[key] = typeof value === 'string' ? value : JSON.stringify(value);
            }
            if (code.includes('import.meta.env')) {
                const env = { ...config.env, SSR: true };
                for (const [key, value] of Object.entries(env)) define[`import.meta.env.${key}`] = JSON.stringify(value);
                define['import.meta.env'] = JSON.stringify(env);
            }
            if (!Object.keys(define).length) return null;
            try {
                return { code: compile(file.endsWith('.js') || !path.extname(file) ? file : file + '.js', code, { lang: 'js', define, jsx: 'preserve' }).code, map: null };
            } catch {
                return null;
            }
        },
    };
}
