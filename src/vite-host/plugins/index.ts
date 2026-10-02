/**
 * lunx's built-in plugins, in the slots Vite gives its own: alias, resolve,
 * css, oxc (TS/JSX), json, asset, define, css-post and import-analysis.
 */

import fs from 'node:fs';
import path from 'node:path';
import { compile } from '../../engines/index.js';
import { assetPlugin } from './asset.js';
import { cssPlugin, cssPostPlugin } from './css.js';
import { importAnalysisPlugin } from './import-analysis.js';
import { resolvePlugin } from './resolve.js';
import { cleanUrl } from '../utils.js';

const SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url|inline)\b/;

export function corePlugins(config: any, user: { pre: any[]; normal: any[]; post: any[] }): any[] {
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
                if (!/\.(m?ts|[jt]sx|cts)$/.test(file) || SPECIAL_QUERY_RE.test(id)) return null;
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
                    jsx,
                    legacyDecorators: !!ts.experimentalDecorators,
                    decoratorMetadata: !!ts.emitDecoratorMetadata,
                    sourcemap: false,
                });
                return { code: result.code, map: null };
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
                return { code: lines.join('\n'), map: null };
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
            if (id.includes('node_modules') && !code.includes('import.meta.env')) return null;
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
