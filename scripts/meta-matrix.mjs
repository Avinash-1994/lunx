/**
 * Meta-framework check: real Next.js / Astro / SvelteKit projects run through
 * `lunx dev` and `lunx build` (which delegate to each framework's own CLI).
 * Asserts the dev server serves the page and the production build succeeds.
 *
 * Run: npx tsx scripts/meta-matrix.mjs [--only=next,astro]
 * Projects are installed once under the OS temp dir and reused.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = process.env.LUNX_CLI ? path.resolve(REPO, process.env.LUNX_CLI) : path.join(REPO, 'src', 'cli.ts');
const LOADER = process.env.LUNX_CLI ? [] : ['--import', 'tsx'];
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',');
const MARKER = 'LUNX-META-OK';

const PROJECTS = [
    {
        name: 'next',
        deps: { next: '15.5.4', react: '19.2.3', 'react-dom': '19.2.3' },
        files: {
            'app/layout.jsx': `export default function RootLayout({ children }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`,
            'app/page.jsx': `export default function Page() {\n  return <h1>${MARKER}</h1>;\n}\n`,
        },
    },
    {
        name: 'astro',
        deps: { astro: '5.14.1' },
        files: {
            'src/pages/index.astro': `---\nconst title = '${MARKER}';\n---\n<html><body><h1>{title}</h1></body></html>\n`,
        },
    },
    {
        name: 'sveltekit',
        deps: { '@sveltejs/kit': '2.43.2', '@sveltejs/adapter-static': '3.0.9', '@sveltejs/vite-plugin-svelte': '6.2.1', svelte: '5.55.5', vite: '7.1.9' },
        files: {
            'svelte.config.js': `import adapter from '@sveltejs/adapter-static';\nexport default { kit: { adapter: adapter() } };\n`,
            'vite.config.js': `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n`,
            'src/app.html': `<!doctype html>\n<html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>\n`,
            'src/routes/+layout.js': `export const prerender = true;\n`,
            'src/routes/+page.svelte': `<h1>${MARKER}</h1>\n`,
        },
    },
    {
        name: 'nuxt',
        deps: { nuxt: '4.1.2', vue: '3.5.26' },
        files: {
            'app/app.vue': `<template>\n  <h1>${MARKER}</h1>\n</template>\n`,
            'nuxt.config.ts': `export default defineNuxtConfig({ telemetry: false, devtools: { enabled: false } });\n`,
        },
    },
    {
        name: 'react-router',
        deps: {
            'react-router': '7.9.4', '@react-router/dev': '7.9.4', '@react-router/node': '7.9.4', '@react-router/serve': '7.9.4',
            react: '19.2.3', 'react-dom': '19.2.3', isbot: '5.1.31', vite: '7.1.9',
        },
        files: {
            'vite.config.js': `import { reactRouter } from '@react-router/dev/vite';\nexport default { plugins: [reactRouter()] };\n`,
            'app/root.jsx': `import { Links, Meta, Outlet, Scripts } from 'react-router';\nexport default function Root() {\n  return <html lang="en"><head><Meta /><Links /></head><body><Outlet /><Scripts /></body></html>;\n}\n`,
            'app/routes.js': `import { index } from '@react-router/dev/routes';\nexport default [index('routes/home.jsx')];\n`,
            'app/routes/home.jsx': `export default function Home() {\n  return <h1>${MARKER}</h1>;\n}\n`,
        },
    },
];

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function run(cmd, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, env: { ...process.env, NO_COLOR: '1', NEXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', (d) => (output += d));
        child.stderr.on('data', (d) => (output += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, output });
        });
    });
}

async function setup(project) {
    const dir = path.join(os.tmpdir(), `lunx-meta-${project.name}`);
    const stamp = path.join(dir, '.installed');
    const key = JSON.stringify(project.deps);
    await fsp.mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(project.files)) {
        await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fsp.writeFile(path.join(dir, rel), content);
    }
    if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== key) {
        await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `meta-${project.name}`, private: true, type: 'module', dependencies: project.deps }, null, 2));
        console.log(`installing ${project.name}...`);
        const install = await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir, 600_000);
        if (install.code !== 0) throw new Error(`install failed: ${install.output.slice(-400)}`);
        await fsp.writeFile(stamp, key);
    }
    return dir;
}

async function devCheck(dir) {
    const port = await freePort();
    const child = spawn(process.execPath, [...LOADER, CLI, 'dev', '--root', dir, '--port', String(port)], { cwd: REPO, env: { ...process.env, NO_COLOR: '1', NEXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    const started = Date.now();
    try {
        while (Date.now() - started < 120_000) {
            try {
                const res = await fetch(`http://localhost:${port}/`);
                const html = await res.text();
                if (html.includes(MARKER)) return { pass: true, ms: Date.now() - started, delegated: /\[lunx\] .* project →/.test(output) };
            } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 250));
        }
        return { pass: false, note: output.trim().split('\n').slice(-3).join(' | ').slice(0, 240) };
    } finally {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 500));
        child.kill('SIGKILL');
    }
}

const results = [];
for (const project of PROJECTS.filter((p) => !only || only.includes(p.name))) {
    const row = { name: project.name, dev: 'skip', build: 'skip', notes: [] };
    try {
        const dir = await setup(project);
        const dev = await devCheck(dir);
        row.dev = dev.pass ? 'pass' : 'fail';
        if (dev.pass && !dev.delegated) row.notes.push('served, but not via delegation');
        if (!dev.pass) row.notes.push(dev.note);
        const build = await run(process.execPath, [...LOADER, CLI, 'build', '--root', dir], REPO, 300_000);
        row.build = build.code === 0 ? 'pass' : 'fail';
        if (build.code !== 0) row.notes.push(`build: ${build.output.trim().split('\n').slice(-3).join(' | ').slice(0, 240)}`);
    } catch (err) {
        row.notes.push(String(err.message).slice(0, 240));
    }
    results.push(row);
    console.log(`${row.name.padEnd(10)} dev:${row.dev.padEnd(5)} build:${row.build}`);
    for (const n of row.notes) console.log(`           ↳ ${n}`);
}

const passed = results.reduce((n, r) => n + (r.dev === 'pass') + (r.build === 'pass'), 0);
console.log(`\n${passed}/${results.length * 2} meta-framework checks passed`);
await fsp.writeFile(path.join(REPO, 'reports', 'META_MATRIX.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
process.exit(passed === results.length * 2 ? 0 : 1);
