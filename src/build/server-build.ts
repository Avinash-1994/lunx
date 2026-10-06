/**
 * Server targets on the engine: `platform: 'node' | 'edge'` bundles the
 * server entry (library mode's builder with the app's dependencies left to
 * node_modules, or, for edge runtimes, bundled in), and `preset: 'ssr'`
 * builds the browser app and the server bundle side by side
 * (outDir/browser, outDir/node), the layout the legacy engine used.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BuildConfig } from '../config/index.js';
import { buildLibrary } from './library.js';
import { productionBuild } from './production.js';

const SERVER_ENTRIES = [
    'src/server.ts', 'src/server.js', 'src/entry-server.tsx', 'src/entry-server.ts', 'src/entry-server.jsx', 'src/entry-server.js',
    'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js', 'server.ts', 'server.js', 'index.ts', 'index.js',
];

function serverEntries(config: BuildConfig, root: string): string[] {
    const listed = (config.entry ?? []).filter((e) => !e.endsWith('.html'));
    if (listed.length) return listed;
    const found = SERVER_ENTRIES.find((f) => fs.existsSync(path.join(root, f)));
    if (!found) throw new Error(`No server entry found: set \`entry\` in lunx.config (looked for ${SERVER_ENTRIES.slice(0, 6).join(', ')}, …)`);
    return [found];
}

export async function serverBuild(config: BuildConfig, framework: string): Promise<{ success: true; engine: string; durationMs: number; modules: string[] }> {
    const started = performance.now();
    const root = path.resolve(config.root || process.cwd());
    const outDir = config.outDir || 'dist';
    const modules = new Set<string>();
    const isSsr = config.preset === 'ssr';
    const platform = config.platform === 'edge' ? 'edge' : 'node';

    if (isSsr) {
        // The browser half is the page (index.html and its scripts), not the server entries.
        // Projects that render every page on the server have none; they get only the server half.
        const listed = (config.entry ?? []).filter((e) => e.endsWith('.html'));
        const pages = listed.length ? listed : fs.existsSync(path.join(root, 'index.html')) ? ['index.html'] : [];
        if (pages.length) {
            const client = await productionBuild({ ...config, entry: pages, platform: 'browser', outDir: path.join(outDir, 'browser') } as BuildConfig, framework);
            for (const m of client.modules) modules.add(m);
        }
    }

    const entries = serverEntries(config, root);
    const server = await buildLibrary(root, {
        entry: entries,
        formats: ['es'],
        platform,
        outDir: isSsr ? path.join(outDir, 'node') : outDir,
        dts: false,
        minify: config.build?.minify === true,
        sourcemap: config.build?.sourcemap === 'external' || config.build?.sourcemap === 'inline',
        checkPackage: false,
    }, framework);
    for (const m of server.modules) modules.add(m);

    return { success: true, engine: 'rolldown', durationMs: performance.now() - started, modules: [...modules] };
}
