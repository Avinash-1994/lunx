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
import crypto from 'node:crypto';
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
        vite = await loadConfigModule(path.join(root, file), root);
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
    if (Object.keys(build).length) config.build = build;
    const input = b.rollupOptions?.input ?? b.rolldownOptions?.input;
    if (input) config.entry = typeof input === 'string' ? [input] : Array.isArray(input) ? input : Object.values(input);
    if (b.lib) notes.push('build.lib is not mapped; use `lunx lib-build` for library output');
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
async function loadConfigModule(file: string, root: string): Promise<any> {
    const esbuild = await import('esbuild');
    const dir = path.dirname(file);
    const result = await esbuild.build({
        entryPoints: [file],
        bundle: true,
        write: false,
        platform: 'node',
        format: 'esm',
        packages: 'external',
        logLevel: 'silent',
        define: {
            'import.meta.url': JSON.stringify(pathToFileURL(file).href),
            'import.meta.dirname': JSON.stringify(dir),
            'import.meta.filename': JSON.stringify(file),
            __dirname: JSON.stringify(dir),
            __filename: JSON.stringify(file),
        },
    });
    const code = result.outputFiles[0]!.text;
    // Next to the project's node_modules so the config's bare imports resolve.
    const tmpDir = path.join(root, 'node_modules', '.lunx');
    await fsp.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `vite.config.${crypto.createHash('sha1').update(code).digest('hex').slice(0, 8)}.mjs`);
    await fsp.writeFile(tmp, code);
    try {
        const mod = await import(pathToFileURL(tmp).href);
        return mod.default ?? mod;
    } finally {
        await fsp.rm(tmp, { force: true });
    }
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
