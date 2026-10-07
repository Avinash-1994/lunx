/**
 * CSS in dev: `vite:css` compiles any style request with lunx's CSS compiler
 * (PostCSS config, Sass/Less/Stylus, CSS Modules, LightningCSS);
 * `vite:css-post` turns the result into what the importer needs — a module
 * that injects the sheet with HMR, the sheet as a string (`?inline`), raw CSS
 * for <link> (`?direct`), or class names on the server.
 */

import path from 'node:path';
import { compileCss, isCssModule } from '../../build/css.js';
import { cleanUrl, FS_PREFIX, isCSSRequest, normalizePath } from '../utils.js';

const SKIP_RE = /[?&](?:worker|sharedworker|raw|url)\b/;
const INLINE_RE = /[?&]inline\b/;
const DIRECT_RE = /[?&]direct\b/;

export function cssPlugin(config: any): any {
    return {
        name: 'vite:css',
        async transform(this: any, code: string, id: string) {
            if (!isCSSRequest(id) || SKIP_RE.test(id)) return null;
            const file = cleanUrl(id);
            const isModule = isCssModule(file) || /[?&]lang\.module\.\w+/.test(id);
            const compiled = await compileCss({
                root: config.root,
                file: /\.(css|pcss|postcss|scss|sass|less|styl|stylus)$/i.test(file) ? file : file + '.css',
                source: code,
                modules: isModule,
                minify: false,
                resolveUrl: (from, url) => devUrl(config, from, url),
            });
            for (const dep of compiled.dependencies) {
                if (dep !== file && path.isAbsolute(dep)) this.addWatchFile(dep);
            }
            const meta = { vite: { cssModules: compiled.exports ?? null } };
            return { code: compiled.code, map: null, meta };
        },
    };
}

export function cssPostPlugin(_config: any): any {
    return {
        name: 'vite:css-post',
        transform(this: any, css: string, id: string) {
            if (!isCSSRequest(id) || SKIP_RE.test(id)) return null;
            const modules: Record<string, string> | null = this.getModuleInfo(id)?.meta?.vite?.cssModules ?? null;
            const isClient = this.environment.config.consumer === 'client';
            const modulesCode = modules
                ? [
                      `const __modules__ = ${JSON.stringify(modules)};`,
                      'export default __modules__;',
                      ...Object.keys(modules).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k)).map((k) => `export const ${k} = __modules__[${JSON.stringify(k)}];`),
                  ].join('\n')
                : '';
            if (INLINE_RE.test(id)) return { code: `export default ${JSON.stringify(css)};`, map: null };
            if (!isClient) return { code: modulesCode || 'export default "";', map: null };
            if (DIRECT_RE.test(id)) return { code: css, map: null };
            const cssId = JSON.stringify(normalizePath(cleanUrl(id)));
            return {
                code: [
                    'import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from "/@vite/client";',
                    `const __vite__id = ${cssId};`,
                    `const __vite__css = ${JSON.stringify(css)};`,
                    '__vite__updateStyle(__vite__id, __vite__css);',
                    modulesCode || 'import.meta.hot.accept();\nexport default __vite__css;',
                    'import.meta.hot.prune(() => __vite__removeStyle(__vite__id));',
                ].join('\n'),
                map: null,
            };
        },
    };
}

/** A `url()` in a dev stylesheet, as a URL the dev server serves. */
function devUrl(config: any, from: string, url: string): string {
    if (/^(data:|https?:|\/\/|#)/.test(url)) return url;
    const [clean, suffix = ''] = url.split(/(?=[?#])/);
    if (clean!.startsWith('/')) return config.base.replace(/\/$/, '') + url;
    const abs = path.resolve(path.dirname(from), clean!);
    const rel = path.relative(config.root, abs);
    const pathname = !rel.startsWith('..') && !path.isAbsolute(rel) ? '/' + normalizePath(rel) : FS_PREFIX.slice(0, -1) + normalizePath(abs);
    return config.base.replace(/\/$/, '') + pathname + suffix;
}
