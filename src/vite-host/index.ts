/**
 * lunx's Vite-compatible host: run Vite-based frameworks (SvelteKit, Nuxt,
 * Astro, React Router, Qwik City…) on lunx and Rolldown.
 */

import { installViteRedirect } from './loader.js';

export async function startViteHostDev(root: string, options: { port?: number; host?: string; mode?: string } = {}): Promise<any> {
    installViteRedirect();
    // Frameworks read their own config from the working directory (SvelteKit's svelte.config.js), as under the Vite CLI.
    if (process.cwd() !== root) process.chdir(root);
    const { createServer } = await import('./server.js');
    const server = await createServer({
        root,
        mode: options.mode,
        server: { ...(options.port ? { port: options.port } : {}), ...(options.host ? { host: options.host } : {}) },
    });
    await server.listen();
    server.config.logger.info(`\n  lunx (vite host)  ready\n`);
    server.printUrls();
    return server;
}

export async function runViteHostBuild(root: string, options: { mode?: string } = {}): Promise<void> {
    installViteRedirect();
    if (process.cwd() !== root) process.chdir(root);
    // As the Vite CLI: a builder; without a `buildApp` it builds the one environment `vite build` would.
    const { createBuilder } = await import('./build.js');
    await (await createBuilder({ root, mode: options.mode })).buildApp();
}

/**
 * Run a framework's own CLI (e.g. `react-router build`) inside this process,
 * with `vite` already pointing at lunx: the framework orchestrates its builds
 * exactly as it does under Vite, on lunx + Rolldown.
 */
export async function runFrameworkCli(root: string, bin: string, args: string[]): Promise<void> {
    installViteRedirect();
    if (process.cwd() !== root) process.chdir(root);
    const fs = await import('node:fs');
    const { pathToFileURL } = await import('node:url');
    const real = fs.realpathSync(bin);
    process.argv = [process.execPath, real, ...args];
    await import(pathToFileURL(real).href);
}
