/**
 * Meta-framework check: real Next.js, Nuxt, Astro, SvelteKit, React Router,
 * VitePress, SolidStart, Docusaurus, Waku, TanStack Start, Qwik City, Marko Run, Remix and Analog projects run through
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
// The built CLI by default: the plugin host redirects vite/rollup imports to its
// compiled shims (dist/plugin-host/*.js), which a source checkout does not have.
const BUILT = path.join(REPO, 'dist', 'cli.js');
const CLI = process.env.LUNX_CLI ? path.resolve(REPO, process.env.LUNX_CLI) : fs.existsSync(BUILT) ? BUILT : path.join(REPO, 'src', 'cli.ts');
const LOADER = CLI.endsWith('.ts') ? ['--import', 'tsx'] : [];
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',');
const MARKER = 'LUNX-META-OK';
const NG = '21.2.25';

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
    {
        name: 'vitepress',
        // Dev pages render client-side; the served shell is the signal.
        devMarker: 'id="app"',
        deps: { vitepress: '1.6.4', vue: '3.5.26' },
        files: {
            'index.md': `# ${MARKER}\n\nHello from VitePress.\n`,
        },
    },
    {
        name: 'solidstart',
        deps: { '@solidjs/start': '1.2.0', '@solidjs/router': '0.15.3', 'solid-js': '1.9.15', vinxi: '0.5.8' },
        files: {
            'app.config.js': `import { defineConfig } from '@solidjs/start/config';\nexport default defineConfig({});\n`,
            'src/app.jsx': `import { Router } from '@solidjs/router';\nimport { FileRoutes } from '@solidjs/start/router';\nimport { Suspense } from 'solid-js';\nexport default function App() {\n  return <Router root={(props) => <Suspense>{props.children}</Suspense>}><FileRoutes /></Router>;\n}\n`,
            'src/entry-client.jsx': `import { mount, StartClient } from '@solidjs/start/client';\nmount(() => <StartClient />, document.getElementById('app'));\n`,
            'src/entry-server.jsx': `import { createHandler, StartServer } from '@solidjs/start/server';\nexport default createHandler(() => (\n  <StartServer document={({ assets, children, scripts }) => (\n    <html lang="en"><head>{assets}</head><body><div id="app">{children}</div>{scripts}</body></html>\n  )} />\n));\n`,
            'src/routes/index.jsx': `export default function Home() {\n  return <h1>${MARKER}</h1>;\n}\n`,
        },
    },
    {
        name: 'docusaurus',
        // Docusaurus' webpack build wants no package.json "type" at all.
        type: null,
        // Dev renders client-side; the served shell is the signal.
        devMarker: '__docusaurus',
        deps: { '@docusaurus/core': '3.10.2', '@docusaurus/preset-classic': '3.10.2', react: '19.2.3', 'react-dom': '19.2.3' },
        files: {
            'docusaurus.config.js': `module.exports = {\n  title: 'meta',\n  url: 'https://example.com',\n  baseUrl: '/',\n  presets: [['classic', { docs: false, blog: false }]],\n};\n`,
            'babel.config.js': `module.exports = { presets: [require.resolve('@docusaurus/core/lib/babel/preset')] };\n`,
            'src/pages/index.js': `export default function Home() {\n  return <h1>${MARKER}</h1>;\n}\n`,
        },
    },
    {
        name: 'waku',
        deps: { waku: '1.0.0-rc.2', react: '19.3.0', 'react-dom': '19.3.0', 'react-server-dom-webpack': '19.3.0' },
        files: {
            'src/pages/index.jsx': `export default async function Home() {\n  return <h1>${MARKER}</h1>;\n}\nexport const getConfig = async () => ({ render: 'static' });\n`,
        },
    },
    {
        name: 'tanstack-start',
        deps: { '@tanstack/react-start': '1.168.60', '@tanstack/react-router': '1.170.41', react: '19.2.3', 'react-dom': '19.2.3', vite: '7.1.9', '@vitejs/plugin-react': '5.2.0' },
        files: {
            'vite.config.js': `import { tanstackStart } from '@tanstack/react-start/plugin/vite';\nimport react from '@vitejs/plugin-react';\nexport default { plugins: [tanstackStart(), react()] };\n`,
            'src/router.jsx': `import { createRouter } from '@tanstack/react-router';\nimport { routeTree } from './routeTree.gen';\nexport function getRouter() {\n  return createRouter({ routeTree });\n}\n`,
            'src/routes/__root.jsx': `import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router';\nexport const Route = createRootRoute({ shellComponent: ({ children }) => (\n  <html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>\n) });\n`,
            'src/routes/index.jsx': `import { createFileRoute } from '@tanstack/react-router';\nexport const Route = createFileRoute('/')({ component: () => <h1>${MARKER}</h1> });\n`,
        },
    },
    {
        name: 'qwik-city',
        deps: { '@builder.io/qwik': '1.20.1', '@builder.io/qwik-city': '1.20.1', vite: '7.1.9' },
        files: {
            'vite.config.js': `import { qwikVite } from '@builder.io/qwik/optimizer';\nimport { qwikCity } from '@builder.io/qwik-city/vite';\nexport default { plugins: [qwikCity(), qwikVite()] };\n`,
            'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: '@builder.io/qwik', module: 'ES2022', moduleResolution: 'bundler', target: 'ES2022' } }),
            'src/root.tsx': `import { component$ } from '@builder.io/qwik';\nimport { QwikCityProvider, RouterOutlet } from '@builder.io/qwik-city';\nexport default component$(() => (\n  <QwikCityProvider><head><meta charset="utf-8" /></head><body><RouterOutlet /></body></QwikCityProvider>\n));\n`,
            'src/entry.ssr.tsx': `import { renderToStream } from '@builder.io/qwik/server';\nimport { manifest } from '@qwik-client-manifest';\nimport Root from './root';\nexport default function (opts: any) {\n  return renderToStream(<Root />, { manifest, ...opts, containerAttributes: { lang: 'en' } });\n}\n`,
            'src/routes/index.tsx': `import { component$ } from '@builder.io/qwik';\nexport default component$(() => <h1>${MARKER}</h1>);\n`,
        },
    },
    {
        name: 'marko-run',
        deps: { '@marko/run': '0.11.13', marko: '6.4.1' },
        files: {
            'src/routes/+page.marko': `<h1>${MARKER}</h1>\n`,
        },
    },
    {
        name: 'remix',
        deps: {
            '@remix-run/dev': '2.17.5', '@remix-run/react': '2.17.5', '@remix-run/node': '2.17.5', '@remix-run/serve': '2.17.5',
            react: '18.3.1', 'react-dom': '18.3.1', isbot: '5.1.31', vite: '6.3.6',
        },
        files: {
            'vite.config.js': `import { vitePlugin as remix } from '@remix-run/dev';\nexport default { plugins: [remix()] };\n`,
            'app/root.jsx': `import { Links, Meta, Outlet, Scripts } from '@remix-run/react';\nexport default function App() {\n  return <html lang="en"><head><Meta /><Links /></head><body><Outlet /><Scripts /></body></html>;\n}\n`,
            'app/routes/_index.jsx': `export default function Index() {\n  return <h1>${MARKER}</h1>;\n}\n`,
        },
    },
    {
        name: 'analog',
        deps: {
            '@analogjs/platform': '2.8.0', '@analogjs/router': '2.8.0', '@analogjs/content': '2.8.0',
            '@angular/core': NG, '@angular/common': NG, '@angular/compiler': NG, '@angular/compiler-cli': NG,
            '@angular/platform-browser': NG, '@angular/platform-server': NG, '@angular/router': NG, '@angular/build': NG,
            rxjs: '7.8.2', tslib: '2.8.1', typescript: '5.9.3', vite: '7.1.9',
        },
        files: {
            'vite.config.ts': `import { defineConfig } from 'vite';\nimport analog from '@analogjs/platform';\nexport default defineConfig({ resolve: { mainFields: ['module'] }, plugins: [analog({ ssr: true, prerender: { routes: [] } })] });\n`,
            'index.html': `<!doctype html>\n<html lang="en"><head><meta charset="utf-8" /><base href="/" /></head><body><app-root></app-root><script type="module" src="/src/main.ts"></script></body></html>\n`,
            'src/main.ts': `import { bootstrapApplication } from '@angular/platform-browser';\nimport { AppComponent } from './app/app.component';\nimport { appConfig } from './app/app.config';\nbootstrapApplication(AppComponent, appConfig);\n`,
            'src/main.server.ts': `import '@angular/platform-server/init';\nimport { render } from '@analogjs/router/server';\nimport { AppComponent } from './app/app.component';\nimport { config } from './app/app.config.server';\nexport default render(AppComponent, config);\n`,
            'src/app/app.config.ts': `import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';\nimport { provideClientHydration } from '@angular/platform-browser';\nimport { provideFileRouter } from '@analogjs/router';\nexport const appConfig: ApplicationConfig = { providers: [provideZonelessChangeDetection(), provideFileRouter(), provideClientHydration()] };\n`,
            'src/app/app.config.server.ts': `import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';\nimport { provideServerRendering } from '@angular/platform-server';\nimport { appConfig } from './app.config';\nexport const config: ApplicationConfig = mergeApplicationConfig(appConfig, { providers: [provideServerRendering()] });\n`,
            'src/app/app.component.ts': `import { Component } from '@angular/core';\nimport { RouterOutlet } from '@angular/router';\n@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })\nexport class AppComponent {}\n`,
            'src/app/pages/index.page.ts': `import { Component } from '@angular/core';\n@Component({ selector: 'app-home', template: '<h1>${MARKER}</h1>' })\nexport default class HomeComponent {}\n`,
            'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, experimentalDecorators: true, moduleResolution: 'bundler', importHelpers: true, target: 'ES2022', module: 'ES2022', lib: ['ES2022', 'dom'], useDefineForClassFields: false, skipLibCheck: true } }),
            'tsconfig.app.json': JSON.stringify({ extends: './tsconfig.json', compilerOptions: { types: [] }, files: ['src/main.ts', 'src/main.server.ts'], include: ['src/**/*.d.ts', 'src/app/pages/**/*.page.ts'] }),
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
    const key = JSON.stringify(project.type !== undefined ? [project.deps, project.type] : project.deps);
    await fsp.mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(project.files)) {
        await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fsp.writeFile(path.join(dir, rel), content);
    }
    if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== key) {
        await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: `meta-${project.name}`, private: true, ...(project.type === null ? {} : { type: project.type ?? 'module' }), dependencies: project.deps }, null, 2));
        console.log(`installing ${project.name}...`);
        const install = await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir, 600_000);
        if (install.code !== 0) throw new Error(`install failed: ${install.output.slice(-400)}`);
        await fsp.writeFile(stamp, key);
    }
    return dir;
}

async function devCheck(dir, marker = MARKER) {
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
                if (html.includes(marker)) return { pass: true, ms: Date.now() - started, delegated: /\[lunx\] .* project →/.test(output) };
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
        const dev = await devCheck(dir, project.devMarker);
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
// A partial run (--only) updates its projects' rows and keeps the others.
const reportFile = path.join(REPO, 'reports', 'META_MATRIX.json');
let report = results;
if (only) {
    const previous = await fsp.readFile(reportFile, 'utf8').then((t) => JSON.parse(t).results).catch(() => []);
    report = PROJECTS.map((p) => results.find((r) => r.name === p.name) ?? previous.find((r) => r.name === p.name)).filter(Boolean);
}
await fsp.writeFile(reportFile, JSON.stringify({ generatedAt: new Date().toISOString(), results: report }, null, 2));
process.exit(passed === results.length * 2 ? 0 : 1);
