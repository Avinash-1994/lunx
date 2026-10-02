/**
 * Meta-frameworks (Next.js, Nuxt, SvelteKit, Astro, Remix, …) are compilers
 * and servers in their own right: routing, server rendering and data loading
 * live in their toolchains. Rather than imitate them, `lunx dev|build|preview`
 * runs the framework's own CLI, says so, and stays the one command a project
 * uses. Lunx's own commands (test, check, security, audit, analyze) still apply.
 *
 * Opt out with `delegate: false` in lunx.config or LUNX_NO_DELEGATE=1.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type Command = 'dev' | 'build' | 'preview';

interface MetaFramework {
    name: string;
    /** Any of these in package.json marks the project. */
    packages: string[];
    bin: string;
    args: Record<Command, string[]>;
    /** How the CLI takes a port, if it does. */
    port?: (port: number) => string[];
}

const viteLike = (name: string, packages: string[]): MetaFramework => ({
    name,
    packages,
    bin: 'vite',
    args: { dev: ['dev'], build: ['build'], preview: ['preview'] },
    port: (p) => ['--port', String(p), '--strictPort'],
});

/** Most specific first: e.g. React Router before plain Vite projects. */
export const META_FRAMEWORKS: MetaFramework[] = [
    { name: 'Next.js', packages: ['next'], bin: 'next', args: { dev: ['dev'], build: ['build'], preview: ['start'] }, port: (p) => ['-p', String(p)] },
    { name: 'Nuxt', packages: ['nuxt'], bin: 'nuxt', args: { dev: ['dev'], build: ['build'], preview: ['preview'] }, port: (p) => ['--port', String(p)] },
    { name: 'Astro', packages: ['astro'], bin: 'astro', args: { dev: ['dev'], build: ['build'], preview: ['preview'] }, port: (p) => ['--port', String(p)] },
    { name: 'Gatsby', packages: ['gatsby'], bin: 'gatsby', args: { dev: ['develop'], build: ['build'], preview: ['serve'] }, port: (p) => ['-p', String(p)] },
    { name: 'Docusaurus', packages: ['@docusaurus/core'], bin: 'docusaurus', args: { dev: ['start'], build: ['build'], preview: ['serve'] }, port: (p) => ['--port', String(p)] },
    { name: 'RedwoodJS', packages: ['@redwoodjs/core'], bin: 'rw', args: { dev: ['dev'], build: ['build'], preview: ['serve'] } },
    { name: 'React Router (framework)', packages: ['@react-router/dev'], bin: 'react-router', args: { dev: ['dev'], build: ['build'], preview: ['start'] }, port: (p) => ['--port', String(p)] },
    { name: 'Remix', packages: ['@remix-run/dev'], bin: 'remix', args: { dev: ['vite:dev'], build: ['vite:build'], preview: ['vite:dev'] }, port: (p) => ['--port', String(p)] },
    { name: 'SolidStart', packages: ['@solidjs/start'], bin: 'vinxi', args: { dev: ['dev'], build: ['build'], preview: ['start'] }, port: (p) => ['--port', String(p)] },
    { name: 'TanStack Start', packages: ['@tanstack/react-start', '@tanstack/solid-start', '@tanstack/start'], bin: 'vite', args: { dev: ['dev'], build: ['build'], preview: ['preview'] }, port: (p) => ['--port', String(p)] },
    { name: 'Waku', packages: ['waku'], bin: 'waku', args: { dev: ['dev'], build: ['build'], preview: ['start'] }, port: (p) => ['--port', String(p)] },
    { name: 'VitePress', packages: ['vitepress'], bin: 'vitepress', args: { dev: ['dev'], build: ['build'], preview: ['preview'] }, port: (p) => ['--port', String(p)] },
    { name: 'Stencil', packages: ['@stencil/core'], bin: 'stencil', args: { dev: ['build', '--dev', '--watch', '--serve'], build: ['build'], preview: ['build', '--dev', '--watch', '--serve'] }, port: (p) => ['--port', String(p)] },
    { name: 'Marko Run', packages: ['@marko/run'], bin: 'marko-run', args: { dev: ['dev'], build: ['build'], preview: ['preview'] }, port: (p) => ['--port', String(p)] },
    viteLike('SvelteKit', ['@sveltejs/kit']),
    // Qwik City renders server-side in dev only in `--mode ssr` (its starter's dev script).
    { ...viteLike('Qwik City', ['@builder.io/qwik-city', '@qwik.dev/router']), args: { dev: ['--mode', 'ssr'], build: ['build'], preview: ['preview'] } },
    viteLike('Analog', ['@analogjs/platform']),
];

export function detectMetaFramework(root: string): MetaFramework | null {
    if (process.env.LUNX_NO_DELEGATE === '1') return null;
    let pkg: any;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch {
        return null;
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return META_FRAMEWORKS.find((m) => m.packages.some((p) => p in deps)) ?? null;
}

/** Find the framework CLI in the project's node_modules/.bin (walking up for workspaces). */
function findBin(root: string, bin: string): string | null {
    const names = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
    for (let dir = root; ; dir = path.dirname(dir)) {
        for (const name of names) {
            const candidate = path.join(dir, 'node_modules', '.bin', name);
            if (fs.existsSync(candidate)) return candidate;
        }
        if (path.dirname(dir) === dir) return null;
    }
}

/**
 * Run the meta-framework's own CLI for `command`. Resolves with its exit
 * code once it exits (dev and preview keep running until stopped).
 */
export async function delegate(meta: MetaFramework, command: Command, root: string, opts: { port?: number; extraArgs?: string[] } = {}): Promise<number> {
    const bin = findBin(root, meta.bin);
    if (!bin) {
        console.error(`[lunx] ${meta.name} project, but its CLI (${meta.bin}) is not installed. Run your package manager's install first.`);
        return 1;
    }
    const args = [...meta.args[command], ...(opts.port && meta.port ? meta.port(opts.port) : []), ...(opts.extraArgs ?? [])];
    console.log(`[lunx] ${meta.name} project → ${meta.bin} ${args.join(' ')}`);
    console.log(`[lunx] ${meta.name} compiles with its own toolchain; lunx test, check, security and analyze still apply. (delegate: false to opt out)`);
    return new Promise((resolve) => {
        const child = spawn(bin, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
        const stop = () => child.kill('SIGTERM');
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        child.on('exit', (code, signal) => resolve(code ?? (signal ? 0 : 1)));
        child.on('error', (err) => {
            console.error(`[lunx] could not start ${meta.bin}: ${err.message}`);
            resolve(1);
        });
    });
}

/**
 * CLI entry: run `command` through the project's meta-framework when there is
 * one. Returns false (the caller continues with lunx's own pipeline) when the
 * project is not a meta-framework, opts out with `delegate: false`, or the
 * framework CLI is not installed.
 */
export async function maybeDelegate(command: Command, root: string, port?: number): Promise<boolean> {
    const meta = detectMetaFramework(root);
    if (!meta) return false;
    const { loadConfig } = await import('../config/index.js');
    const optOut = await loadConfig(root).then((c: any) => c?.delegate === false).catch(() => false);
    if (optOut) return false;
    if (!findBin(root, meta.bin)) {
        console.warn(`[lunx] ${meta.name} project, but its CLI (${meta.bin}) is not installed; using lunx's built-in ${meta.name} support. Install dependencies to run the full framework.`);
        return false;
    }
    process.exitCode = await delegate(meta, command, root, { port });
    return true;
}
