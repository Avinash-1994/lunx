/**
 * `build.legacy` (as @vitejs/plugin-legacy): a second script per page for
 * browsers without ES modules, loaded with `nomodule` so modern browsers
 * skip it.
 *
 * The legacy files are built from the modern output, not the sources: each
 * entry chunk is bundled again with its lazy chunks inlined, as one IIFE,
 * with its syntax lowered by Oxc and the core-js polyfills its targets need
 * first. Everything else the modern build did (CSS, assets, framework
 * compilers, plugins) is reused as is.
 *
 *   build: { legacy: true }                                  // ES2015 browsers without modules
 *   build: { legacy: { targets: ['ie11'], babel: true } }     // ES5, with @babel/preset-env
 *
 * Oxc lowers syntax down to ES2015. For ES5 (Internet Explorer 11) the
 * project's `@babel/core` and `@babel/preset-env` finish the job.
 */

import path from 'node:path';
import { createRequire } from 'node:module';

export interface LegacyOptions {
    /** Browsers the legacy files are for (core-js-compat names: 'chrome60', 'safari10', 'ie11'…). */
    targets?: string[];
    /** Lower to ES5 with the project's Babel (`@babel/core` + `@babel/preset-env`). Default: when a target is IE. */
    babel?: boolean;
}

export interface LegacyEntry {
    /** The modern entry chunk, relative to the output directory. */
    fileName: string;
}

export const DEFAULT_LEGACY_TARGETS = ['chrome49', 'edge15', 'firefox52', 'safari10', 'ios10'];

/** Safari 10.1 runs both `type="module"` and `nomodule` scripts; this stops the nomodule ones (from @vitejs/plugin-legacy). */
export const SAFARI_NOMODULE_FIX = `!function(){var e=document,t=e.createElement("script");if(!("noModule"in t)&&"onbeforeload"in t){var n=!1;e.addEventListener("beforeload",function(e){if(e.target===t)n=!0;else if(!e.target.hasAttribute("nomodule")||!n)return;e.preventDefault()},!0),t.type="module",t.src=".",e.head.appendChild(t),t.remove()}}();`;

/** Builds `<entry>-legacy.<hash>.js` beside each modern entry. Returns modern file → legacy file. */
export async function buildLegacy(
    root: string,
    outDir: string,
    entries: LegacyEntry[],
    options: LegacyOptions | true,
    define: Record<string, string>,
    /** `build.chunkImportMap`: the stable chunk names the modern chunks import (relative to outDir) → their files. */
    renamed: Map<string, string> = new Map(),
): Promise<Map<string, string>> {
    const opts: LegacyOptions = options === true ? {} : options;
    const targets = opts.targets?.length ? opts.targets : DEFAULT_LEGACY_TARGETS;
    const es5 = opts.babel ?? targets.some((t) => /^ie\d/.test(t));
    const babel = es5 ? loadBabel(root) : null;
    const { rolldown } = await import('rolldown');
    const { entryPolyfills } = await import('./polyfills.js');
    const req = createRequire(path.join(root, 'package.json'));
    let polyfills = '';
    try {
        req.resolve('core-js/package.json');
        polyfills = entryPolyfills(root, targets);
    } catch {
        // No core-js in the project: syntax is lowered, built-ins are not polyfilled.
    }
    const result = new Map<string, string>();
    for (const entry of entries) {
        const modern = path.join(outDir, entry.fileName);
        const wrapper = `\0lunx-legacy:${entry.fileName}`;
        const bundle = await rolldown({
            input: wrapper,
            cwd: root,
            platform: 'browser',
            logLevel: 'silent',
            transform: { target: es5 ? 'es2015' : targets.some((t) => /^(chrome|edge|firefox|safari|ios|opera|samsung)/.test(t)) ? targets : 'es2015', define },
            plugins: [
                {
                    name: 'lunx:legacy-entry',
                    resolveId(id: string, importer?: string) {
                        if (id === wrapper) return id;
                        if (renamed.size && importer && id.startsWith('.')) {
                            const rel = path.relative(outDir, path.resolve(path.dirname(importer), id)).split(path.sep).join('/');
                            const real = renamed.get(rel);
                            if (real) return path.join(outDir, real);
                        }
                        // core-js resolves from the project, wherever the modern chunks live.
                        if (id.startsWith('core-js/')) return req.resolve(id);
                        return null;
                    },
                    load(id: string) {
                        if (id !== wrapper) return null;
                        return { code: `${polyfills}import ${JSON.stringify(modern)};\n`, moduleSideEffects: true };
                    },
                },
                ...(babel
                    ? [{
                          name: 'lunx:legacy-babel',
                          async renderChunk(code: string) {
                              const out = await babel.core.transformAsync(code, {
                                  babelrc: false,
                                  configFile: false,
                                  compact: true,
                                  sourceType: 'script',
                                  presets: [[babel.presetEnv, { targets: babelTargets(targets), modules: false, bugfixes: true }]],
                              });
                              return out?.code ?? null;
                          },
                      }]
                    : []),
            ],
        } as any);
        try {
            const { output } = await bundle.write({
                dir: outDir,
                format: 'iife',
                codeSplitting: false,
                entryFileNames: `${entry.fileName.replace(/\.[^./]+(\.js)$/, '').replace(/\.js$/, '')}-legacy.[hash].js`,
                minify: true,
                comments: { legal: false, annotation: false, jsdoc: false },
            } as any);
            result.set(entry.fileName, output[0]!.fileName);
        } finally {
            await bundle.close();
        }
    }
    return result;
}

/** `chrome49` → `{ chrome: '49' }` for @babel/preset-env. */
function babelTargets(targets: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of targets) {
        const m = /^([a-z]+)(\d+(?:\.\d+)*)$/.exec(t);
        if (m && m[1] !== 'es') out[m[1]!] = m[2]!;
    }
    return out;
}

function loadBabel(root: string): { core: any; presetEnv: any } {
    const req = createRequire(path.join(root, 'package.json'));
    try {
        const core = req('@babel/core');
        const env = req('@babel/preset-env');
        return { core, presetEnv: env.default ?? env };
    } catch {
        throw new Error('build.legacy for ES5 browsers needs @babel/core and @babel/preset-env: npm install -D @babel/core @babel/preset-env');
    }
}

/** The page with a `nomodule` script after each modern entry script, and Safari 10.1's fix. */
export function addLegacyScripts(page: string, scripts: Array<{ modernUrl: string; legacyUrl: string }>): string {
    for (const { modernUrl, legacyUrl } of scripts) {
        const re = new RegExp(`(<script\\b[^>]*\\bsrc=["']${modernUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>\\s*</script>)`);
        page = page.replace(re, `$1\n    <script nomodule crossorigin src="${legacyUrl}"></script>`);
    }
    if (scripts.length && !page.includes('"noModule"in t')) {
        const fix = `<script>${SAFARI_NOMODULE_FIX}</script>`;
        page = /<\/head>/i.test(page) ? page.replace(/<\/head>/i, `    ${fix}\n  </head>`) : fix + page;
    }
    return page;
}
