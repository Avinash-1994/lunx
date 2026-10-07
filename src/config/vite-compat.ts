/**
 * Read an existing `vite.config.*` so a Vite project runs under lunx with no
 * changes (`npx lunx dev` / `npx lunx build`), and so `lunx migrate` can write
 * an equivalent `lunx.config.ts`.
 *
 * Framework plugins (React, Vue, Svelte, Solid, Preact, …) are replaced by the
 * compilers lunx already has built in; every other plugin is Rollup-compatible
 * and is handed to the Rolldown build as-is.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const VITE_CONFIG_FILES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.cts'];

export interface ForeignConfig {
    file: string;
    /** lunx config fields, ready for schema validation */
    config: Record<string, any>;
    /** non-framework plugins, passed to the Rolldown build */
    plugins: any[];
    notes: string[];
}

/** Plugin name → the lunx framework that replaces it. */
const FRAMEWORK_PLUGINS: Array<[RegExp, string]> = [
    [/^vite:react/, 'react'],
    [/^vite:vue/, 'vue'],
    [/^vite-plugin-svelte/, 'svelte'],
    [/^solid/, 'solid'],
    [/^(preact|vite:preact|prefresh)/, 'preact'],
    [/^(@analogjs|analog)/, 'angular'],
    [/^(vite-plugin-qwik|qwik)/, 'qwik'],
];

export function findViteConfig(root: string): string | null {
    return VITE_CONFIG_FILES.find((f) => fs.existsSync(path.join(root, f))) ?? null;
}

export async function readViteConfig(root: string, command: 'build' | 'serve' = 'build'): Promise<ForeignConfig | null> {
    const file = findViteConfig(root);
    if (!file) return null;
    const notes: string[] = [];
    let vite: any;
    try {
        // Fast path: framework plugins are replaced by lunx anyway, so stub
        // them (and vite's helpers) instead of importing Babel, Vite and the
        // plugin -- ~100ms per command. Any surprise falls back to the real
        // modules.
        try {
            vite = await loadConfigModule(path.join(root, file), root, true);
        } catch {
            vite = await loadConfigModule(path.join(root, file), root, false);
        }
        if (typeof vite === 'function') {
            vite = await vite({ command, mode: command === 'build' ? 'production' : 'development', isSsrBuild: false, isPreview: false });
        }
    } catch (err: any) {
        notes.push(`could not evaluate ${file} (${String(err?.message ?? err).split('\n')[0]}); read it statically instead`);
        return { file, ...staticRead(await fsp.readFile(path.join(root, file), 'utf8')), notes };
    }
    vite = vite ?? {};

    const config: Record<string, any> = {};
    if (vite.base) config.base = vite.base;
    if (vite.publicDir !== undefined && vite.publicDir !== false) config.publicDir = vite.publicDir;
    if (vite.define) {
        config.define = Object.fromEntries(
            Object.entries(vite.define).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
        );
    }

    const alias = vite.resolve?.alias;
    if (alias) {
        const pairs: Array<[unknown, unknown]> = Array.isArray(alias)
            ? alias.map((a: any) => [a.find, a.replacement])
            : Object.entries(alias);
        const mapped: Record<string, string> = {};
        for (const [find, replacement] of pairs) {
            if (typeof find !== 'string' || typeof replacement !== 'string') {
                notes.push(`resolve.alias ${String(find)} is a RegExp; add it to lunx.config by hand`);
                continue;
            }
            mapped[find] = path.isAbsolute(replacement) && isInside(root, replacement)
                ? './' + path.relative(root, replacement).split(path.sep).join('/')
                : replacement;
        }
        if (Object.keys(mapped).length) config.resolve = { alias: mapped };
    }

    const server: Record<string, any> = {};
    for (const key of ['port', 'host', 'strictPort', 'open', 'proxy', 'cors', 'headers'] as const) {
        const value = vite.server?.[key];
        if (value === undefined) continue;
        server[key] = key === 'host' && value === true ? '0.0.0.0' : value;
    }
    if (Object.keys(server).length) config.server = server;
    if (vite.server?.port) config.port = vite.server.port;

    const b = vite.build ?? {};
    if (b.outDir) config.outDir = b.outDir;
    const build: Record<string, any> = {};
    if (b.sourcemap !== undefined) build.sourcemap = b.sourcemap === true ? 'external' : b.sourcemap === false ? 'none' : b.sourcemap;
    if (b.minify === false) build.minify = false;
    if (typeof b.assetsInlineLimit === 'number') build.assetsInlineLimit = b.assetsInlineLimit;
    if (Object.keys(build).length) config.build = build;
    const input = b.rollupOptions?.input ?? b.rolldownOptions?.input;
    if (input) config.entry = typeof input === 'string' ? [input] : Array.isArray(input) ? input : Object.values(input);
    if (b.lib) {
        // Vite's build.lib → lunx library mode (formats, fileName, name, entry, cssFileName).
        const external = b.rollupOptions?.external ?? b.rolldownOptions?.external;
        const globals = (b.rollupOptions?.output ?? b.rolldownOptions?.output)?.globals;
        config.lib = {
            entry: b.lib.entry,
            ...(b.lib.name ? { name: b.lib.name } : {}),
            ...(b.lib.formats ? { formats: b.lib.formats } : {}),
            ...(b.lib.fileName ? { fileName: b.lib.fileName } : {}),
            ...(b.lib.cssFileName ? { cssFileName: b.lib.cssFileName } : {}),
            ...(Array.isArray(external) ? { external } : {}),
            ...(globals ? { globals } : {}),
            ...(b.minify === false ? { minify: false } : {}),
            ...(b.sourcemap ? { sourcemap: true } : {}),
        };
    }
    if (vite.envPrefix) notes.push(`envPrefix ${JSON.stringify(vite.envPrefix)}: lunx exposes LUNX_, VITE_, REACT_APP_ and PUBLIC_ variables`);
    if (vite.css?.preprocessorOptions) notes.push('css.preprocessorOptions is not mapped');

    const plugins: any[] = [];
    for (const plugin of await resolvePlugins(vite.plugins ?? [])) {
        const name = String(plugin?.name ?? '');
        const framework = FRAMEWORK_PLUGINS.find(([re]) => re.test(name))?.[1];
        if (framework) {
            config.framework ??= framework;
            continue;
        }
        if (plugin.apply === 'serve') continue;
        if (typeof plugin.apply === 'function' && !plugin.apply({}, { command: 'build', mode: 'production' })) continue;
        plugins.push(plugin);
    }
    if (plugins.length) notes.push(`using ${plugins.length} Vite plugin(s) in the build: ${plugins.map((p) => p.name).join(', ')}`);
    return { file, config, plugins, notes };
}

/** Best effort when the config cannot run (e.g. vite itself was uninstalled). */
function staticRead(source: string): { config: Record<string, any>; plugins: any[] } {
    const config: Record<string, any> = {};
    const port = source.match(/\bport\s*:\s*(\d+)/);
    if (port) config.server = { port: Number(port[1]) };
    const outDir = source.match(/\boutDir\s*:\s*['"]([^'"]+)['"]/);
    if (outDir) config.outDir = outDir[1];
    const base = source.match(/\bbase\s*:\s*['"]([^'"]+)['"]/);
    if (base) config.base = base[1];
    for (const [pkg, fw] of [
        ['@vitejs/plugin-react', 'react'], ['@vitejs/plugin-vue', 'vue'], ['@sveltejs/vite-plugin-svelte', 'svelte'],
        ['vite-plugin-solid', 'solid'], ['@preact/preset-vite', 'preact'], ['@analogjs/', 'angular'],
    ] as const) {
        if (source.includes(pkg)) {
            config.framework = fw;
            break;
        }
    }
    return { config, plugins: [] };
}

/** Bundle the config with its own imports left external, then import it. */
/** Stand-ins for packages whose only role in a config is to be replaced by lunx. */
const STUBS: Record<string, string> = {
    vite: `export const defineConfig = (c) => c;
export const mergeConfig = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' ? mergeConfig(a[k], v) : Array.isArray(v) && Array.isArray(a?.[k]) ? [...a[k], ...v] : v; return out; };
export const loadEnv = (mode, dir, prefixes = 'VITE_') => { const p = [].concat(prefixes); return Object.fromEntries(Object.entries(process.env).filter(([k]) => p.some((x) => k.startsWith(x)))); };
export const searchForWorkspaceRoot = (dir) => dir;`,
    '@vitejs/plugin-react': `export default () => ({ name: 'vite:react-babel' });`,
    '@vitejs/plugin-react-swc': `export default () => ({ name: 'vite:react-swc' });`,
    '@vitejs/plugin-vue': `export default () => ({ name: 'vite:vue' });`,
    '@vitejs/plugin-vue-jsx': `export default () => ({ name: 'vite:vue-jsx' });`,
    '@sveltejs/vite-plugin-svelte': `export const svelte = () => ({ name: 'vite-plugin-svelte' }); export const vitePreprocess = () => ({});`,
    'vite-plugin-solid': `export default () => ({ name: 'solid' });`,
    '@preact/preset-vite': `export default () => ({ name: 'preact:config' });`,
};

async function loadConfigModule(file: string, root: string, stubFrameworks: boolean): Promise<any> {
    const { importBundled } = await import('../lib/load-module.js');
    return importBundled(file, { root, stubs: stubFrameworks ? STUBS : {} });
}

/** Vite allows nested arrays, falsy entries and promises in `plugins`. */
async function resolvePlugins(list: unknown): Promise<any[]> {
    const out: any[] = [];
    for (const item of await Promise.all(Array.isArray(list) ? list : [list])) {
        if (Array.isArray(item)) out.push(...(await resolvePlugins(item)));
        else if (item && typeof item === 'object') out.push(item);
    }
    return out;
}

function isInside(dir: string, file: string): boolean {
    const rel = path.relative(dir, file);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}
