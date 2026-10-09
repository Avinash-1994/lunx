/**
 * The projects `lunx create` / `create-lunx` scaffold: the smallest real app
 * of each framework, on the dependency versions the framework matrices run
 * (scripts/browser-matrix.mjs, scripts/meta-matrix.mjs). Every starter is
 * scaffolded from the packed package, installed, built, served and opened in
 * a browser by scripts/template-matrix.mjs.
 */

export interface StarterOptions {
    name: string;
    /** TypeScript (default) or JavaScript, for starters with `js: true`. */
    ts: boolean;
    /** Tailwind CSS, for starters with `tailwind: true`. */
    tailwind: boolean;
}

export interface Starter {
    id: string;
    label: string;
    group: 'App' | 'Framework' | 'Other';
    /** Earlier template ids that still select this starter. */
    aliases?: string[];
    /** Can be generated as JavaScript. */
    js?: boolean;
    /** Can add Tailwind CSS (its stylesheet is src/index.css). */
    tailwind?: boolean;
    /** Builds with its own CLI, which `lunx dev` / `lunx build` run. */
    ownCli?: boolean;
    /** package.json "type"; null leaves it out (Docusaurus' webpack build wants none). */
    type?: 'module' | null;
    /** Scripts other than dev / build / preview. */
    scripts?: Record<string, string>;
    dependencies(o: StarterOptions): Record<string, string>;
    devDependencies?(o: StarterOptions): Record<string, string>;
    files(o: StarterOptions): Record<string, string>;
}

const REACT = '^19.2.3';
const VUE = '^3.5.26';
const SVELTE = '^5.55.5';
const ANGULAR = '^20.3.4';
const TYPESCRIPT = '^5.9.3';

const lines = (...l: string[]) => l.join('\n') + '\n';
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const ext = (o: StarterOptions, jsx = false) => (o.ts ? (jsx ? 'tsx' : 'ts') : jsx ? 'jsx' : 'js');
/** `!` after a DOM lookup in TypeScript; nothing in JavaScript. */
const nn = (o: StarterOptions) => (o.ts ? '!' : '');

const BASE_CSS = lines(
    ':root {',
    '  font-family: system-ui, sans-serif;',
    '  color-scheme: light dark;',
    '}',
    'body {',
    '  margin: 0;',
    '  min-height: 100vh;',
    '  display: grid;',
    '  place-items: center;',
    '  text-align: center;',
    '}',
    'button {',
    '  font: inherit;',
    '  padding: 0.5em 1.2em;',
    '  border-radius: 8px;',
    '  border: 1px solid #8886;',
    '  cursor: pointer;',
    '}',
);

/** src/index.css: plain, or Tailwind's entry. */
const css = (o: StarterOptions) => (o.tailwind ? lines('@import "tailwindcss";', '', BASE_CSS.trimEnd()) : BASE_CSS);

function tailwindDeps(o: StarterOptions): Record<string, string> {
    return o.tailwind ? { tailwindcss: '^4.1.18', '@tailwindcss/postcss': '^4.1.18', postcss: '^8.5.6' } : {};
}

function tailwindFiles(o: StarterOptions): Record<string, string> {
    return o.tailwind ? { 'postcss.config.mjs': lines("export default { plugins: { '@tailwindcss/postcss': {} } };") } : {};
}

function html(o: StarterOptions, entry: string, body = '<div id="app"></div>'): string {
    return lines(
        '<!doctype html>',
        '<html lang="en">',
        '  <head>',
        '    <meta charset="UTF-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        `    <title>${o.name}</title>`,
        '  </head>',
        '  <body>',
        `    ${body}`,
        `    <script type="module" src="/${entry}"></script>`,
        '  </body>',
        '</html>',
    );
}

function config(o: StarterOptions, options = ''): Record<string, string> {
    return {
        [`lunx.config.${o.ts ? 'ts' : 'js'}`]: lines(
            "import { defineConfig } from 'lunx-dev';",
            '',
            `export default defineConfig({${options ? ` ${options} ` : ''}});`,
        ),
    };
}

function tsconfig(o: StarterOptions, compilerOptions: Record<string, unknown> = {}, include = ['src']): Record<string, string> {
    if (!o.ts) return {};
    return {
        'tsconfig.json': json({
            compilerOptions: {
                target: 'ES2022',
                module: 'ESNext',
                moduleResolution: 'bundler',
                lib: ['ES2022', 'DOM', 'DOM.Iterable'],
                strict: true,
                skipLibCheck: true,
                noEmit: true,
                isolatedModules: true,
                ...compilerOptions,
            },
            include,
        }),
    };
}

const typescript = (o: StarterOptions): Record<string, string> => (o.ts ? { typescript: TYPESCRIPT } : {});

// ── Apps: lunx's own dev server and build ──────────────────────────────────

const vanilla: Starter = {
    id: 'vanilla',
    label: 'Vanilla',
    aliases: ['vanilla-ts', 'vanilla-js'],
    group: 'App',
    js: true,
    tailwind: true,
    dependencies: () => ({}),
    devDependencies: (o) => ({ ...typescript(o), ...tailwindDeps(o) }),
    files: (o) => ({
        'index.html': html(o, `src/main.${ext(o)}`),
        [`src/main.${ext(o)}`]: lines(
            "import './index.css';",
            '',
            `const app = document.getElementById('app')${nn(o)};`,
            `app.innerHTML = '<h1>${o.name}</h1><button id="counter" type="button">count is 0</button>';`,
            '',
            `const button = document.getElementById('counter')${nn(o)};`,
            'let count = 0;',
            "button.addEventListener('click', () => {",
            '  count += 1;',
            '  button.textContent = `count is ${count}`;',
            '});',
        ),
        'src/index.css': css(o),
        ...config(o),
        ...tsconfig(o),
        ...tailwindFiles(o),
    }),
};

const react: Starter = {
    id: 'react',
    label: 'React',
    group: 'App',
    aliases: ['react-spa', 'react-ts'],
    js: true,
    tailwind: true,
    dependencies: () => ({ react: REACT, 'react-dom': REACT }),
    devDependencies: (o) => ({ ...(o.ts ? { '@types/react': '^19.2.2', '@types/react-dom': '^19.2.2' } : {}), ...typescript(o), ...tailwindDeps(o) }),
    files: (o) => ({
        'index.html': html(o, `src/main.${ext(o, true)}`, '<div id="root"></div>'),
        [`src/main.${ext(o, true)}`]: lines(
            "import { StrictMode } from 'react';",
            "import { createRoot } from 'react-dom/client';",
            "import App from './App';",
            "import './index.css';",
            '',
            `createRoot(document.getElementById('root')${nn(o)}).render(`,
            '  <StrictMode>',
            '    <App />',
            '  </StrictMode>,',
            ');',
        ),
        [`src/App.${ext(o, true)}`]: lines(
            "import { useState } from 'react';",
            '',
            'export default function App() {',
            '  const [count, setCount] = useState(0);',
            '  return (',
            '    <main>',
            `      <h1>${o.name}</h1>`,
            '      <button type="button" onClick={() => setCount((c) => c + 1)}>',
            '        count is {count}',
            '      </button>',
            '    </main>',
            '  );',
            '}',
        ),
        'src/index.css': css(o),
        ...config(o),
        ...tsconfig(o, { jsx: 'react-jsx' }),
        ...tailwindFiles(o),
    }),
};

const preact: Starter = {
    id: 'preact',
    label: 'Preact',
    group: 'App',
    aliases: ['preact-spa', 'preact-ts', 'preact-js'],
    js: true,
    tailwind: true,
    dependencies: () => ({ preact: '^10.29.8' }),
    devDependencies: (o) => ({ ...typescript(o), ...tailwindDeps(o) }),
    files: (o) => ({
        'index.html': html(o, `src/main.${ext(o, true)}`),
        [`src/main.${ext(o, true)}`]: lines(
            "import { render } from 'preact';",
            "import App from './App';",
            "import './index.css';",
            '',
            `render(<App />, document.getElementById('app')${nn(o)});`,
        ),
        [`src/App.${ext(o, true)}`]: lines(
            "import { useState } from 'preact/hooks';",
            '',
            'export default function App() {',
            '  const [count, setCount] = useState(0);',
            '  return (',
            '    <main>',
            `      <h1>${o.name}</h1>`,
            '      <button type="button" onClick={() => setCount(count + 1)}>',
            '        count is {count}',
            '      </button>',
            '    </main>',
            '  );',
            '}',
        ),
        'src/index.css': css(o),
        ...config(o, "framework: 'preact'"),
        ...tsconfig(o, { jsx: 'react-jsx', jsxImportSource: 'preact' }),
        ...tailwindFiles(o),
    }),
};

const vue: Starter = {
    id: 'vue',
    label: 'Vue',
    group: 'App',
    aliases: ['vue-spa', 'vue-ts'],
    js: true,
    tailwind: true,
    dependencies: () => ({ vue: VUE }),
    devDependencies: (o) => ({ ...typescript(o), ...tailwindDeps(o) }),
    files: (o) => ({
        'index.html': html(o, `src/main.${ext(o)}`),
        [`src/main.${ext(o)}`]: lines(
            "import { createApp } from 'vue';",
            "import App from './App.vue';",
            "import './index.css';",
            '',
            "createApp(App).mount('#app');",
        ),
        'src/App.vue': lines(
            `<script setup${o.ts ? ' lang="ts"' : ''}>`,
            "import { ref } from 'vue';",
            '',
            'const count = ref(0);',
            '</script>',
            '',
            '<template>',
            '  <main>',
            `    <h1>${o.name}</h1>`,
            '    <button type="button" @click="count++">count is {{ count }}</button>',
            '  </main>',
            '</template>',
        ),
        ...(o.ts ? { 'src/env.d.ts': lines("declare module '*.vue' {", "  import type { DefineComponent } from 'vue';", '  const component: DefineComponent;', '  export default component;', '}') } : {}),
        'src/index.css': css(o),
        ...config(o),
        ...tsconfig(o, { jsx: 'preserve' }),
        ...tailwindFiles(o),
    }),
};

const svelte: Starter = {
    id: 'svelte',
    label: 'Svelte',
    group: 'App',
    aliases: ['svelte-spa', 'svelte-ts'],
    js: true,
    tailwind: true,
    dependencies: () => ({}),
    devDependencies: (o) => ({ svelte: SVELTE, ...typescript(o), ...tailwindDeps(o) }),
    files: (o) => ({
        'index.html': html(o, `src/main.${ext(o)}`),
        [`src/main.${ext(o)}`]: lines(
            "import { mount } from 'svelte';",
            "import App from './App.svelte';",
            "import './index.css';",
            '',
            `mount(App, { target: document.getElementById('app')${nn(o)} });`,
        ),
        'src/App.svelte': lines(
            `<script${o.ts ? ' lang="ts"' : ''}>`,
            '  let count = $state(0);',
            '</script>',
            '',
            '<main>',
            `  <h1>${o.name}</h1>`,
            '  <button type="button" onclick={() => count++}>count is {count}</button>',
            '</main>',
        ),
        ...(o.ts ? { 'src/env.d.ts': lines("declare module '*.svelte' {", "  import type { Component } from 'svelte';", '  const component: Component;', '  export default component;', '}') } : {}),
        'src/index.css': css(o),
        ...config(o),
        ...tsconfig(o),
        ...tailwindFiles(o),
    }),
};

const solid: Starter = {
    id: 'solid',
    label: 'Solid',
    group: 'App',
    aliases: ['solid-spa', 'solid-ts'],
    js: true,
    tailwind: true,
    dependencies: () => ({ 'solid-js': '^1.9.15' }),
    // Solid's JSX compiles to fine-grained updates with its Babel preset.
    devDependencies: (o) => ({ 'babel-preset-solid': '^1.9.10', '@babel/core': '^7.28.5', ...typescript(o), ...tailwindDeps(o) }),
    files: (o) => ({
        'index.html': html(o, `src/main.${ext(o, true)}`),
        [`src/main.${ext(o, true)}`]: lines(
            "import { render } from 'solid-js/web';",
            "import App from './App';",
            "import './index.css';",
            '',
            `render(() => <App />, document.getElementById('app')${nn(o)});`,
        ),
        [`src/App.${ext(o, true)}`]: lines(
            "import { createSignal } from 'solid-js';",
            '',
            'export default function App() {',
            '  const [count, setCount] = createSignal(0);',
            '  return (',
            '    <main>',
            `      <h1>${o.name}</h1>`,
            '      <button type="button" onClick={() => setCount(count() + 1)}>',
            '        count is {count()}',
            '      </button>',
            '    </main>',
            '  );',
            '}',
        ),
        'src/index.css': css(o),
        ...config(o, "framework: 'solid'"),
        ...tsconfig(o, { jsx: 'preserve', jsxImportSource: 'solid-js' }),
        ...tailwindFiles(o),
    }),
};

const lit: Starter = {
    id: 'lit',
    label: 'Lit',
    group: 'App',
    aliases: ['lit-spa', 'lit-ts'],
    js: true,
    tailwind: false,
    dependencies: () => ({ lit: '^3.3.3' }),
    devDependencies: (o) => typescript(o),
    files: (o) => ({
        'index.html': html(o, `src/main.${ext(o)}`, '<app-root></app-root>'),
        [`src/main.${ext(o)}`]: lines("import './index.css';", "import './app-root';"),
        [`src/app-root.${ext(o)}`]: o.ts
            ? lines(
                  "import { LitElement, css, html } from 'lit';",
                  "import { customElement, state } from 'lit/decorators.js';",
                  '',
                  "@customElement('app-root')",
                  'export class AppRoot extends LitElement {',
                  '  static styles = css`h1 { margin-top: 0; }`;',
                  '',
                  '  @state() count = 0;',
                  '',
                  '  render() {',
                  `    return html\`<h1>${o.name}</h1><button type="button" @click=\${() => this.count++}>count is \${this.count}</button>\`;`,
                  '  }',
                  '}',
              )
            : lines(
                  "import { LitElement, css, html } from 'lit';",
                  '',
                  'export class AppRoot extends LitElement {',
                  '  static properties = { count: { state: true } };',
                  '  static styles = css`h1 { margin-top: 0; }`;',
                  '',
                  '  constructor() {',
                  '    super();',
                  '    this.count = 0;',
                  '  }',
                  '',
                  '  render() {',
                  `    return html\`<h1>${o.name}</h1><button type="button" @click=\${() => this.count++}>count is \${this.count}</button>\`;`,
                  '  }',
                  '}',
                  '',
                  "customElements.define('app-root', AppRoot);",
              ),
        'src/index.css': BASE_CSS,
        ...config(o),
        ...tsconfig(o, { experimentalDecorators: true, useDefineForClassFields: false }),
    }),
};

const alpine: Starter = {
    id: 'alpine',
    label: 'Alpine.js',
    group: 'App',
    aliases: ['alpine-spa', 'alpine-ts'],
    js: true,
    tailwind: true,
    dependencies: () => ({ alpinejs: '^3.14.9' }),
    devDependencies: (o) => ({ ...(o.ts ? { '@types/alpinejs': '^3.13.11' } : {}), ...typescript(o), ...tailwindDeps(o) }),
    files: (o) => ({
        'index.html': html(
            o,
            `src/main.${ext(o)}`,
            `<main x-data="{ count: 0 }"><h1>${o.name}</h1><button type="button" @click="count++" x-text="\`count is \${count}\`">count is 0</button></main>`,
        ),
        [`src/main.${ext(o)}`]: lines("import Alpine from 'alpinejs';", "import './index.css';", '', 'Alpine.start();'),
        'src/index.css': css(o),
        ...config(o),
        ...tsconfig(o),
        ...tailwindFiles(o),
    }),
};

const angular: Starter = {
    id: 'angular',
    label: 'Angular',
    group: 'App',
    aliases: ['angular-spa'],
    dependencies: () => ({
        '@angular/common': ANGULAR,
        '@angular/compiler': ANGULAR,
        '@angular/core': ANGULAR,
        '@angular/platform-browser': ANGULAR,
        rxjs: '^7.8.2',
        tslib: '^2.8.1',
    }),
    devDependencies: () => ({ typescript: '~5.9.3' }),
    files: (o) => ({
        'index.html': html(o, 'src/main.ts', '<app-root></app-root>'),
        'src/main.ts': lines(
            "import '@angular/compiler';",
            "import { provideZonelessChangeDetection } from '@angular/core';",
            "import { bootstrapApplication } from '@angular/platform-browser';",
            "import { AppComponent } from './app/app.component';",
            "import './index.css';",
            '',
            'bootstrapApplication(AppComponent, { providers: [provideZonelessChangeDetection()] });',
        ),
        'src/app/app.component.ts': lines(
            "import { Component, signal } from '@angular/core';",
            '',
            '@Component({',
            "  selector: 'app-root',",
            "  templateUrl: './app.component.html',",
            "  styleUrl: './app.component.css',",
            '})',
            'export class AppComponent {',
            `  title = '${o.name}';`,
            '  count = signal(0);',
            '}',
        ),
        'src/app/app.component.html': lines(
            '<main>',
            '  <h1>{{ title }}</h1>',
            '  <button type="button" (click)="count.set(count() + 1)">count is {{ count() }}</button>',
            '</main>',
        ),
        'src/app/app.component.css': lines('h1 { margin-top: 0; }'),
        'src/index.css': BASE_CSS,
        ...config(o, "framework: 'angular'"),
        ...tsconfig(o, { experimentalDecorators: true, useDefineForClassFields: false, strict: false }),
    }),
};

const qwik: Starter = {
    id: 'qwik',
    label: 'Qwik',
    group: 'App',
    aliases: ['qwik-spa', 'qwik-ts'],
    dependencies: () => ({ '@builder.io/qwik': '^1.17.1' }),
    devDependencies: () => ({ typescript: TYPESCRIPT }),
    files: (o) => ({
        'index.html': html(o, 'src/main.tsx'),
        'src/main.tsx': lines(
            "import '@builder.io/qwik/qwikloader.js';",
            "import { render } from '@builder.io/qwik';",
            "import { App } from './app';",
            "import './index.css';",
            '',
            "render(document.getElementById('app')!, <App />);",
        ),
        'src/app.tsx': lines(
            "import { component$, useSignal } from '@builder.io/qwik';",
            '',
            'export const App = component$(() => {',
            '  const count = useSignal(0);',
            '  return (',
            '    <main>',
            `      <h1>${o.name}</h1>`,
            '      <button type="button" onClick$={() => count.value++}>',
            '        count is {count.value}',
            '      </button>',
            '    </main>',
            '  );',
            '});',
        ),
        'src/index.css': BASE_CSS,
        ...config(o, "framework: 'qwik'"),
        ...tsconfig(o, { jsx: 'react-jsx', jsxImportSource: '@builder.io/qwik' }),
    }),
};

// ── Frameworks: their routing and SSR, built by lunx (or their own CLI) ────

/** A meta-framework starter: its files are its own, lunx runs it. */
function framework(s: Omit<Starter, 'group' | 'dependencies' | 'files'> & { deps: Record<string, string>; devDeps?: Record<string, string>; files(name: string): Record<string, string> }): Starter {
    return {
        ...s,
        group: 'Framework',
        dependencies: () => s.deps,
        devDependencies: s.devDeps ? () => s.devDeps! : undefined,
        files: (o) => s.files(o.name),
    };
}

const next = framework({
    id: 'next',
    label: 'Next.js',
    aliases: ['nextjs'],
    ownCli: true,
    deps: { next: '^15.5.4', react: REACT, 'react-dom': REACT },
    files: (name) => ({
        'app/layout.jsx': lines(
            `export const metadata = { title: '${name}' };`,
            '',
            'export default function RootLayout({ children }) {',
            '  return (',
            '    <html lang="en">',
            '      <body>{children}</body>',
            '    </html>',
            '  );',
            '}',
        ),
        'app/page.jsx': lines('export default function Page() {', `  return <h1>${name}</h1>;`, '}'),
    }),
});

const nuxt = framework({
    id: 'nuxt',
    label: 'Nuxt',
    aliases: ['nuxt-app'],
    deps: { nuxt: '^4.1.2', vue: VUE },
    files: (name) => ({
        'app/app.vue': lines('<template>', `  <h1>${name}</h1>`, '</template>'),
        'nuxt.config.ts': lines('export default defineNuxtConfig({', '  devtools: { enabled: false },', '});'),
    }),
});

const sveltekit = framework({
    id: 'sveltekit',
    label: 'SvelteKit',
    aliases: ['sveltekit-app'],
    deps: { '@sveltejs/kit': '^2.43.2', '@sveltejs/adapter-static': '^3.0.9', '@sveltejs/vite-plugin-svelte': '^6.2.1', svelte: SVELTE, vite: '^7.1.9' },
    files: (name) => ({
        'svelte.config.js': lines("import adapter from '@sveltejs/adapter-static';", '', 'export default { kit: { adapter: adapter() } };'),
        'vite.config.js': lines("import { sveltekit } from '@sveltejs/kit/vite';", '', 'export default { plugins: [sveltekit()] };'),
        'src/app.html': lines(
            '<!doctype html>',
            '<html lang="en">',
            '  <head>',
            '    <meta charset="utf-8" />',
            '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
            '    %sveltekit.head%',
            '  </head>',
            '  <body>',
            '    <div>%sveltekit.body%</div>',
            '  </body>',
            '</html>',
        ),
        'src/routes/+layout.js': lines('export const prerender = true;'),
        'src/routes/+page.svelte': lines('<script>', '  let count = $state(0);', '</script>', '', `<h1>${name}</h1>`, '<button type="button" onclick={() => count++}>count is {count}</button>'),
    }),
});

const astro = framework({
    id: 'astro',
    label: 'Astro',
    aliases: ['astro-spa'],
    deps: { astro: '^5.14.1' },
    files: (name) => ({
        'src/pages/index.astro': lines('---', `const title = '${name}';`, '---', '<html lang="en">', '  <head><meta charset="utf-8" /><title>{title}</title></head>', '  <body><h1>{title}</h1></body>', '</html>'),
    }),
});

const reactRouter = framework({
    id: 'react-router',
    label: 'React Router (framework mode)',
    aliases: ['react-router-v7-app'],
    deps: {
        'react-router': '^7.9.4',
        '@react-router/dev': '^7.9.4',
        '@react-router/node': '^7.9.4',
        '@react-router/serve': '^7.9.4',
        react: REACT,
        'react-dom': REACT,
        isbot: '^5.1.31',
        vite: '^7.1.9',
    },
    scripts: { start: 'react-router-serve ./build/server/index.js' },
    files: (name) => ({
        'vite.config.js': lines("import { reactRouter } from '@react-router/dev/vite';", '', 'export default { plugins: [reactRouter()] };'),
        'app/root.jsx': lines(
            "import { Links, Meta, Outlet, Scripts } from 'react-router';",
            '',
            'export default function Root() {',
            '  return (',
            '    <html lang="en">',
            '      <head><meta charSet="utf-8" /><Meta /><Links /></head>',
            '      <body><Outlet /><Scripts /></body>',
            '    </html>',
            '  );',
            '}',
        ),
        'app/routes.js': lines("import { index } from '@react-router/dev/routes';", '', "export default [index('routes/home.jsx')];"),
        'app/routes/home.jsx': lines('export default function Home() {', `  return <h1>${name}</h1>;`, '}'),
    }),
});

const tanstackStart = framework({
    id: 'tanstack-start',
    label: 'TanStack Start',
    aliases: ['tanstack-start-app', 'tanstack'],
    deps: { '@tanstack/react-start': '^1.168.60', '@tanstack/react-router': '^1.170.41', react: REACT, 'react-dom': REACT, vite: '^7.1.9', '@vitejs/plugin-react': '^5.2.0' },
    files: (name) => ({
        'vite.config.js': lines(
            "import { tanstackStart } from '@tanstack/react-start/plugin/vite';",
            "import react from '@vitejs/plugin-react';",
            '',
            'export default { plugins: [tanstackStart(), react()] };',
        ),
        'src/router.jsx': lines("import { createRouter } from '@tanstack/react-router';", "import { routeTree } from './routeTree.gen';", '', 'export function getRouter() {', '  return createRouter({ routeTree });', '}'),
        'src/routes/__root.jsx': lines(
            "import { createRootRoute, HeadContent, Scripts } from '@tanstack/react-router';",
            '',
            'export const Route = createRootRoute({',
            '  shellComponent: ({ children }) => (',
            '    <html lang="en">',
            '      <head><HeadContent /></head>',
            '      <body>{children}<Scripts /></body>',
            '    </html>',
            '  ),',
            '});',
        ),
        'src/routes/index.jsx': lines("import { createFileRoute } from '@tanstack/react-router';", '', "export const Route = createFileRoute('/')({", `  component: () => <h1>${name}</h1>,`, '});'),
    }),
});

const solidstart = framework({
    id: 'solidstart',
    label: 'SolidStart',
    aliases: ['solidstart-app'],
    deps: { '@solidjs/start': '^1.2.0', '@solidjs/router': '^0.15.3', 'solid-js': '^1.9.15', vinxi: '^0.5.8' },
    files: (name) => ({
        'app.config.js': lines("import { defineConfig } from '@solidjs/start/config';", '', 'export default defineConfig({});'),
        'src/app.jsx': lines(
            "import { Router } from '@solidjs/router';",
            "import { FileRoutes } from '@solidjs/start/router';",
            "import { Suspense } from 'solid-js';",
            '',
            'export default function App() {',
            '  return (',
            '    <Router root={(props) => <Suspense>{props.children}</Suspense>}>',
            '      <FileRoutes />',
            '    </Router>',
            '  );',
            '}',
        ),
        'src/entry-client.jsx': lines("import { mount, StartClient } from '@solidjs/start/client';", '', "mount(() => <StartClient />, document.getElementById('app'));"),
        'src/entry-server.jsx': lines(
            "import { createHandler, StartServer } from '@solidjs/start/server';",
            '',
            'export default createHandler(() => (',
            '  <StartServer',
            '    document={({ assets, children, scripts }) => (',
            '      <html lang="en">',
            '        <head>{assets}</head>',
            '        <body><div id="app">{children}</div>{scripts}</body>',
            '      </html>',
            '    )}',
            '  />',
            '));',
        ),
        'src/routes/index.jsx': lines('export default function Home() {', `  return <h1>${name}</h1>;`, '}'),
    }),
});

const qwikCity = framework({
    id: 'qwik-city',
    label: 'Qwik City',
    aliases: ['qwikcity'],
    deps: { '@builder.io/qwik': '^1.20.1', '@builder.io/qwik-city': '^1.20.1', vite: '^7.1.9' },
    files: (name) => ({
        'vite.config.js': lines(
            "import { qwikVite } from '@builder.io/qwik/optimizer';",
            "import { qwikCity } from '@builder.io/qwik-city/vite';",
            '',
            'export default { plugins: [qwikCity(), qwikVite()] };',
        ),
        'tsconfig.json': json({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: '@builder.io/qwik', module: 'ES2022', moduleResolution: 'bundler', target: 'ES2022', skipLibCheck: true } }),
        'src/root.tsx': lines(
            "import { component$ } from '@builder.io/qwik';",
            "import { QwikCityProvider, RouterOutlet } from '@builder.io/qwik-city';",
            '',
            'export default component$(() => (',
            '  <QwikCityProvider>',
            '    <head><meta charset="utf-8" /></head>',
            '    <body><RouterOutlet /></body>',
            '  </QwikCityProvider>',
            '));',
        ),
        'src/entry.ssr.tsx': lines(
            "import { renderToStream } from '@builder.io/qwik/server';",
            "import { manifest } from '@qwik-client-manifest';",
            "import Root from './root';",
            '',
            'export default function (opts: any) {',
            "  return renderToStream(<Root />, { manifest, ...opts, containerAttributes: { lang: 'en' } });",
            '}',
        ),
        // The production server `lunx preview` runs (built with the app, as `qwik build` does).
        'src/entry.preview.tsx': lines(
            "import { createQwikCity } from '@builder.io/qwik-city/middleware/node';",
            "import qwikCityPlan from '@qwik-city-plan';",
            "import render from './entry.ssr';",
            '',
            'export default createQwikCity({ render, qwikCityPlan });',
        ),
        'src/routes/index.tsx': lines("import { component$ } from '@builder.io/qwik';", '', `export default component$(() => <h1>${name}</h1>);`),
    }),
});

const vitepress = framework({
    id: 'vitepress',
    label: 'VitePress',
    aliases: ['vitepress-app'],
    deps: { vitepress: '^1.6.4', vue: VUE },
    files: (name) => ({ 'index.md': lines(`# ${name}`, '', 'Edit `index.md` to get started.') }),
});

const waku = framework({
    id: 'waku',
    label: 'Waku',
    aliases: ['waku-app'],
    deps: { waku: '1.0.0-rc.2', react: '19.3.0', 'react-dom': '19.3.0', 'react-server-dom-webpack': '19.3.0' },
    files: (name) => ({
        'src/pages/index.jsx': lines('export default async function Home() {', `  return <h1>${name}</h1>;`, '}', '', "export const getConfig = async () => ({ render: 'static' });"),
    }),
});

const NG = '^21.2.25';
const analog = framework({
    id: 'analog',
    label: 'Analog (Angular)',
    aliases: ['analog-app'],
    deps: {
        '@analogjs/platform': '^2.8.0',
        '@analogjs/router': '^2.8.0',
        '@analogjs/content': '^2.8.0',
        '@angular/core': NG,
        '@angular/common': NG,
        '@angular/compiler': NG,
        '@angular/compiler-cli': NG,
        '@angular/platform-browser': NG,
        '@angular/platform-server': NG,
        '@angular/router': NG,
        '@angular/build': NG,
        rxjs: '^7.8.2',
        tslib: '^2.8.1',
        typescript: '~5.9.3',
        vite: '^7.1.9',
    },
    files: (name) => ({
        'vite.config.ts': lines(
            "import { defineConfig } from 'vite';",
            "import analog from '@analogjs/platform';",
            '',
            "export default defineConfig({ resolve: { mainFields: ['module'] }, plugins: [analog({ ssr: true, prerender: { routes: [] } })] });",
        ),
        'index.html': lines('<!doctype html>', '<html lang="en">', `  <head><meta charset="utf-8" /><base href="/" /><title>${name}</title></head>`, '  <body><app-root></app-root><script type="module" src="/src/main.ts"></script></body>', '</html>'),
        'src/main.ts': lines(
            "import { bootstrapApplication } from '@angular/platform-browser';",
            "import { AppComponent } from './app/app.component';",
            "import { appConfig } from './app/app.config';",
            '',
            'bootstrapApplication(AppComponent, appConfig);',
        ),
        'src/main.server.ts': lines(
            "import '@angular/platform-server/init';",
            "import { render } from '@analogjs/router/server';",
            "import { AppComponent } from './app/app.component';",
            "import { config } from './app/app.config.server';",
            '',
            'export default render(AppComponent, config);',
        ),
        'src/app/app.config.ts': lines(
            "import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';",
            "import { provideClientHydration } from '@angular/platform-browser';",
            "import { provideFileRouter } from '@analogjs/router';",
            '',
            'export const appConfig: ApplicationConfig = {',
            '  providers: [provideZonelessChangeDetection(), provideFileRouter(), provideClientHydration()],',
            '};',
        ),
        'src/app/app.config.server.ts': lines(
            "import { mergeApplicationConfig, ApplicationConfig } from '@angular/core';",
            "import { provideServerRendering } from '@angular/platform-server';",
            "import { appConfig } from './app.config';",
            '',
            'export const config: ApplicationConfig = mergeApplicationConfig(appConfig, { providers: [provideServerRendering()] });',
        ),
        'src/app/app.component.ts': lines(
            "import { Component } from '@angular/core';",
            "import { RouterOutlet } from '@angular/router';",
            '',
            "@Component({ selector: 'app-root', imports: [RouterOutlet], template: '<router-outlet />' })",
            'export class AppComponent {}',
        ),
        'src/app/pages/index.page.ts': lines("import { Component } from '@angular/core';", '', `@Component({ selector: 'app-home', template: '<h1>${name}</h1>' })`, 'export default class HomeComponent {}'),
        'tsconfig.json': json({
            compilerOptions: {
                strict: true,
                experimentalDecorators: true,
                moduleResolution: 'bundler',
                importHelpers: true,
                target: 'ES2022',
                module: 'ES2022',
                lib: ['ES2022', 'dom'],
                useDefineForClassFields: false,
                skipLibCheck: true,
            },
        }),
        'tsconfig.app.json': json({ extends: './tsconfig.json', compilerOptions: { types: [] }, files: ['src/main.ts', 'src/main.server.ts'], include: ['src/**/*.d.ts', 'src/app/pages/**/*.page.ts'] }),
    }),
});

const remix = framework({
    id: 'remix',
    label: 'Remix',
    deps: {
        '@remix-run/dev': '^2.17.5',
        '@remix-run/react': '^2.17.5',
        '@remix-run/node': '^2.17.5',
        '@remix-run/serve': '^2.17.5',
        react: '^18.3.1',
        'react-dom': '^18.3.1',
        isbot: '^5.1.31',
        vite: '^6.3.6',
    },
    scripts: { start: 'remix-serve ./build/server/index.js' },
    files: (name) => ({
        'vite.config.js': lines("import { vitePlugin as remix } from '@remix-run/dev';", '', 'export default { plugins: [remix()] };'),
        'app/root.jsx': lines(
            "import { Links, Meta, Outlet, Scripts } from '@remix-run/react';",
            '',
            'export default function App() {',
            '  return (',
            '    <html lang="en">',
            '      <head><meta charSet="utf-8" /><Meta /><Links /></head>',
            '      <body><Outlet /><Scripts /></body>',
            '    </html>',
            '  );',
            '}',
        ),
        'app/routes/_index.jsx': lines('export default function Index() {', `  return <h1>${name}</h1>;`, '}'),
    }),
});

const docusaurus = framework({
    id: 'docusaurus',
    label: 'Docusaurus',
    ownCli: true,
    type: null,
    deps: { '@docusaurus/core': '^3.10.2', '@docusaurus/preset-classic': '^3.10.2', react: REACT, 'react-dom': REACT },
    files: (name) => ({
        'docusaurus.config.js': lines('module.exports = {', `  title: '${name}',`, "  url: 'https://example.com',", "  baseUrl: '/',", "  presets: [['classic', { docs: false, blog: false }]],", '};'),
        'babel.config.js': lines("module.exports = { presets: [require.resolve('@docusaurus/core/lib/babel/preset')] };"),
        'src/pages/index.js': lines('export default function Home() {', `  return <h1>${name}</h1>;`, '}'),
    }),
});

const markoRun = framework({
    id: 'marko-run',
    label: 'Marko Run',
    aliases: ['marko'],
    deps: { '@marko/run': '^0.11.13', marko: '^6.4.1' },
    files: (name) => ({ 'src/routes/+page.marko': lines(`<h1>${name}</h1>`) }),
});

// ── Other ──────────────────────────────────────────────────────────────────

const library: Starter = {
    id: 'library',
    label: 'Library (npm package)',
    group: 'Other',
    js: true,
    scripts: { dev: 'lunx build --lib --watch', build: 'lunx build --lib' },
    dependencies: () => ({}),
    devDependencies: (o) => typescript(o),
    files: (o) => ({
        [`src/index.${ext(o)}`]: lines(
            '/** Greets someone. */',
            `export function greet(name${o.ts ? ': string' : ''})${o.ts ? ': string' : ''} {`,
            '  return `Hello, ${name}!`;',
            '}',
        ),
        ...tsconfig(o, { declaration: true }),
    }),
};

const edge: Starter = {
    id: 'edge',
    label: 'Edge function (fetch handler)',
    group: 'Other',
    aliases: ['edge-function'],
    js: true,
    scripts: { dev: 'lunx build --watch', build: 'lunx build' },
    dependencies: () => ({}),
    devDependencies: (o) => typescript(o),
    files: (o) => ({
        [`src/index.${ext(o)}`]: lines(
            'export default {',
            `  async fetch(request${o.ts ? ': Request' : ''})${o.ts ? ': Promise<Response>' : ''} {`,
            '    const { pathname } = new URL(request.url);',
            `    return Response.json({ app: '${o.name}', pathname });`,
            '  },',
            '};',
        ),
        ...config(o, `platform: 'edge', entry: ['src/index.${ext(o)}']`),
        ...tsconfig(o, { lib: ['ES2022', 'WebWorker'] }),
    }),
};

export const STARTERS: Starter[] = [
    vanilla, react, preact, vue, svelte, solid, lit, alpine, angular, qwik,
    next, nuxt, sveltekit, astro, reactRouter, tanstackStart, solidstart, qwikCity, vitepress, waku, analog, remix, docusaurus, markoRun,
    library, edge,
];

export function findStarter(id: string): Starter | undefined {
    const key = id.toLowerCase();
    return STARTERS.find((s) => s.id === key || s.aliases?.includes(key));
}
