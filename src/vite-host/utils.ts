/**
 * Helpers with Vite's exact semantics, shared by the host and exported to
 * plugins through the `vite` module shim.
 */

import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { parse as parseDotenv, expand as expandDotenv } from '../lib/dotenv.js';
import { globToRegExp } from '../lib/watcher.js';

export const VERSION = '7.1.9';

export const isWindows = process.platform === 'win32';

export function slash(p: string): string {
    return p.replace(/\\/g, '/');
}

export function normalizePath(id: string): string {
    return path.posix.normalize(isWindows ? slash(id) : id);
}

export const queryRE = /\?.*$/s;
export const hashRE = /#.*$/s;
export const cleanUrl = (url: string): string => url.replace(hashRE, '').replace(queryRE, '');

export const CSS_LANGS_RE = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;
export const isCSSRequest = (request: string): boolean => CSS_LANGS_RE.test(request);
export const isDirectCSSRequest = (request: string): boolean => isCSSRequest(request) && /[?&]direct\b/.test(request);

export const KNOWN_JS_RE = /\.(?:[mc]?[jt]sx?|vue|svelte|astro|marko|mdx?)(?:$|\?)/;
export const isJSRequest = (url: string): boolean => {
    url = cleanUrl(url);
    if (KNOWN_JS_RE.test(url)) return true;
    return !path.extname(url) && url[url.length - 1] !== '/';
};

export const externalRE = /^([a-z]+:)?\/\//;
export const isExternalUrl = (url: string): boolean => externalRE.test(url);
export const dataUrlRE = /^\s*data:/i;
export const isDataUrl = (url: string): boolean => dataUrlRE.test(url);

export const bareImportRE = /^(?![a-zA-Z]:)[\w@](?!.*:\/\/)/;

export const VALID_ID_PREFIX = '/@id/';
export const NULL_BYTE_PLACEHOLDER = '__x00__';
export const FS_PREFIX = '/@fs/';
export const CLIENT_PUBLIC_PATH = '/@vite/client';
export const ENV_PUBLIC_PATH = '/@vite/env';

export function wrapId(id: string): string {
    return id.startsWith(VALID_ID_PREFIX) ? id : VALID_ID_PREFIX + id.replace('\0', NULL_BYTE_PLACEHOLDER);
}

export function unwrapId(id: string): string {
    return id.startsWith(VALID_ID_PREFIX) ? id.slice(VALID_ID_PREFIX.length).replace(NULL_BYTE_PLACEHOLDER, '\0') : id;
}

export function fsPathFromId(id: string): string {
    const fsPath = normalizePath(id.startsWith(FS_PREFIX) ? id.slice(FS_PREFIX.length) : id);
    return fsPath[0] === '/' || /^[A-Za-z]:/.test(fsPath) ? fsPath : `/${fsPath}`;
}

export function fsPathFromUrl(url: string): string {
    return fsPathFromId(cleanUrl(url));
}

const builtins = new Set(builtinModules);
export function isBuiltin(id: string): boolean {
    if (id.startsWith('node:')) return true;
    return builtins.has(id) || builtins.has(id.split('/')[0]!);
}

export function isInNodeModules(id: string): boolean {
    return id.includes('node_modules');
}

export function isObject(value: unknown): value is Record<string, any> {
    return Object.prototype.toString.call(value) === '[object Object]';
}

export function arraify<T>(target: T | T[]): T[] {
    return Array.isArray(target) ? target : [target];
}

export function injectQuery(url: string, queryToInject: string): string {
    const [base, hash = ''] = url.split('#', 2) as [string, string?];
    const [pathname, search = ''] = base.split('?', 2) as [string, string?];
    return `${pathname}?${queryToInject}${search ? `&${search}` : ''}${hash ? `#${hash}` : ''}`;
}

export function removeTimestampQuery(url: string): string {
    return url.replace(/\bt=\d{13}&?\b/, '').replace(/[?&]$/, '');
}

export function removeImportQuery(url: string): string {
    return url.replace(/(\?|&)import=?(?:&|$)/, '$1').replace(/[?&]$/, '');
}

export function stripBase(url: string, base: string): string {
    if (url === base) return '/';
    const devBase = base.endsWith('/') ? base : base + '/';
    return url.startsWith(devBase) ? url.slice(devBase.length - 1) : url;
}

// ── mergeConfig ──────────────────────────────────────────────────────────────

export interface Alias {
    find: string | RegExp;
    replacement: string;
    customResolver?: unknown;
}

export function normalizeAlias(o: any = []): Alias[] {
    return Array.isArray(o)
        ? o.map(normalizeSingleAlias)
        : Object.keys(o).map((find) => normalizeSingleAlias({ find, replacement: o[find] }));
}

function normalizeSingleAlias({ find, replacement, customResolver }: Alias): Alias {
    if (typeof find === 'string' && find.endsWith('/') && replacement.endsWith('/')) {
        find = find.slice(0, -1);
        replacement = replacement.slice(0, -1);
    }
    const alias: Alias = { find, replacement };
    if (customResolver) alias.customResolver = customResolver;
    return alias;
}

function mergeAlias(a?: any, b?: any): any {
    if (!a) return b;
    if (!b) return a;
    if (isObject(a) && isObject(b)) return { ...a, ...b };
    // the order is flipped: later aliases take priority
    return [...normalizeAlias(b), ...normalizeAlias(a)];
}

function mergeConfigRecursively(defaults: Record<string, any>, overrides: Record<string, any>, rootPath: string): Record<string, any> {
    const merged: Record<string, any> = { ...defaults };
    for (const key in overrides) {
        const value = overrides[key];
        if (value == null) continue;
        const existing = merged[key];
        if (existing == null) {
            merged[key] = value;
            continue;
        }
        if (key === 'alias' && (rootPath === 'resolve' || rootPath === '')) {
            merged[key] = mergeAlias(existing, value);
            continue;
        } else if (key === 'assetsInclude' && rootPath === '') {
            merged[key] = [].concat(existing, value);
            continue;
        } else if (key === 'noExternal' && (rootPath === 'ssr' || rootPath === 'resolve') && (existing === true || value === true)) {
            merged[key] = true;
            continue;
        } else if (key === 'plugins' && rootPath === 'worker') {
            merged[key] = () => [...arraify(existing()), ...arraify(value())];
            continue;
        }
        if (Array.isArray(existing) || Array.isArray(value)) {
            merged[key] = [...arraify(existing ?? []), ...arraify(value ?? [])];
            continue;
        }
        if (isObject(existing) && isObject(value)) {
            merged[key] = mergeConfigRecursively(existing, value, rootPath ? `${rootPath}.${key}` : key);
            continue;
        }
        merged[key] = value;
    }
    return merged;
}

export function mergeConfig(defaults: Record<string, any>, overrides: Record<string, any>, isRoot = true): Record<string, any> {
    if (typeof defaults === 'function' || typeof overrides === 'function') {
        throw new Error('Cannot merge config in form of callback');
    }
    return mergeConfigRecursively(defaults, overrides, isRoot ? '' : '.');
}

// ── env ──────────────────────────────────────────────────────────────────────

export function getEnvFilesForMode(mode: string, envDir: string): string[] {
    return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].map((file) => path.join(envDir, file));
}

export function loadEnv(mode: string, envDir: string, prefixes: string | string[] = 'VITE_'): Record<string, string> {
    if (mode === 'local') {
        throw new Error('"local" cannot be used as a mode name because it conflicts with the .local postfix for .env files.');
    }
    const prefixList = arraify(prefixes);
    const env: Record<string, string> = {};
    const parsed: Record<string, string> = {};
    for (const file of getEnvFilesForMode(mode, envDir)) {
        try {
            Object.assign(parsed, parseDotenv(fs.readFileSync(file)));
        } catch {
            /* missing */
        }
    }
    if (parsed.NODE_ENV && process.env.VITE_USER_NODE_ENV === undefined) process.env.VITE_USER_NODE_ENV = parsed.NODE_ENV;
    if (parsed.BROWSER && process.env.BROWSER === undefined) process.env.BROWSER = parsed.BROWSER;
    const expanded = expandDotenv(parsed, { ...process.env });
    for (const [key, value] of Object.entries(expanded)) {
        if (prefixList.some((prefix) => key.startsWith(prefix))) env[key] = value;
    }
    for (const key in process.env) {
        if (prefixList.some((prefix) => key.startsWith(prefix))) env[key] = process.env[key] as string;
    }
    return env;
}

export function searchForWorkspaceRoot(current: string, root = current): string {
    const markers = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json', 'rush.json', 'bunfig.toml'];
    for (let dir = current; ; dir = path.dirname(dir)) {
        if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg.workspaces) return dir;
        } catch {
            /* none */
        }
        if (path.dirname(dir) === dir) return root;
    }
}

// ── createFilter (@rollup/pluginutils semantics) ─────────────────────────────

export type FilterPattern = ReadonlyArray<string | RegExp> | string | RegExp | null | undefined;

export function createFilter(include?: FilterPattern, exclude?: FilterPattern, options?: { resolve?: string | false | null }): (id: unknown) => boolean {
    const resolutionBase = options?.resolve;
    const toMatcher = (pattern: string | RegExp): RegExp => {
        if (pattern instanceof RegExp) return pattern;
        let p = pattern;
        const isAbs = path.isAbsolute(p) || p.startsWith('**');
        if (resolutionBase !== false && !isAbs) p = slash(path.resolve(resolutionBase || process.cwd(), p));
        return globToRegExp(slash(p));
    };
    const inc = include == null ? [] : arraify(include as any).map(toMatcher);
    const exc = exclude == null ? [] : arraify(exclude as any).map(toMatcher);
    return (id: unknown) => {
        if (typeof id !== 'string' || id.includes('\0')) return false;
        const pathId = slash(id);
        for (const m of exc) {
            m.lastIndex = 0;
            if (m.test(pathId)) return false;
        }
        for (const m of inc) {
            m.lastIndex = 0;
            if (m.test(pathId)) return true;
        }
        return !inc.length;
    };
}

export function prettifyUrl(url: string, root: string): string {
    url = removeTimestampQuery(url);
    if (url.startsWith(FS_PREFIX)) {
        const file = path.relative(root, url.slice(FS_PREFIX.length - 1));
        return file.startsWith('..') ? url : file;
    }
    return url;
}

export function buildErrorMessage(err: any, args: string[] = [], includeStack = true): string {
    if (err.plugin) args.push(`  Plugin: ${err.plugin}`);
    const loc = err.loc ? `:${err.loc.line}:${err.loc.column}` : '';
    if (err.id) args.push(`  File: ${err.id}${loc}`);
    if (err.frame) args.push(err.frame);
    if (includeStack && err.stack) args.push(err.stack);
    return args.join('\n');
}
