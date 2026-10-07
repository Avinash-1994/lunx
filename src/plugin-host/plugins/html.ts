/**
 * HTML entries in builds (Vite's build-html): an `.html` input becomes a JS
 * module importing its module scripts and stylesheets; after bundling the
 * page is rewritten to load the built chunk, its preloads and its CSS, with
 * the plugins' `transformIndexHtml` hooks applied.
 */

import path from 'node:path';
import { cleanUrl, normalizePath } from '../utils.js';
import type { StateLookup } from './build.js';

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const STYLESHEET_RE = /<link\b([^>]*\brel=["']?stylesheet["']?[^>]*)>/gi;
const ATTR = (attrs: string, name: string): string | undefined => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(attrs)?.[1];
const PROXY = '?html-proxy&index=';

function hooksOf(config: any, phase: 'pre' | 'post'): Array<(html: string, ctx: any) => any> {
    const out: any[] = [];
    for (const plugin of config.plugins) {
        const hook = plugin.transformIndexHtml;
        if (!hook) continue;
        const order = typeof hook === 'object' ? hook.order ?? hook.enforce : undefined;
        const handler = typeof hook === 'object' ? hook.handler ?? hook.transform : hook;
        if ((phase === 'pre') === (order === 'pre')) out.push(handler.bind(plugin));
    }
    return out;
}

function serializeTag({ tag, attrs, children }: any): string {
    const attrText = Object.entries(attrs ?? {})
        .filter(([, v]) => v !== false && v != null)
        .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}=${JSON.stringify(String(v))}`))
        .join('');
    const inner = typeof children === 'string' ? children : Array.isArray(children) ? children.map(serializeTag).join('') : '';
    return /^(meta|link|base|br|hr|img|input)$/.test(tag) ? `<${tag}${attrText}>` : `<${tag}${attrText}>${inner}</${tag}>`;
}

function inject(html: string, tags: any[]): string {
    const groups: Record<string, string[]> = { 'head-prepend': [], head: [], 'body-prepend': [], body: [] };
    for (const tag of tags) (groups[tag.injectTo ?? 'head'] ?? groups.head!).push(serializeTag(tag));
    const put = (re: RegExp, text: string, after: boolean) => {
        if (!text) return;
        const m = html.match(re);
        if (!m || m.index === undefined) {
            html = after ? text + html : html + text;
            return;
        }
        const pos = after ? m.index + m[0].length : m.index;
        html = html.slice(0, pos) + text + html.slice(pos);
    };
    put(/<head[^>]*>/i, groups['head-prepend']!.join(''), true);
    put(/<\/head>/i, groups.head!.join(''), false);
    put(/<body[^>]*>/i, groups['body-prepend']!.join(''), true);
    put(/<\/body>/i, groups.body!.join(''), false);
    return html;
}

async function applyHooks(hooks: any[], html: string, ctx: any): Promise<string> {
    const tags: any[] = [];
    for (const hook of hooks) {
        const result = await hook(html, ctx);
        if (!result) continue;
        if (typeof result === 'string') html = result;
        else if (Array.isArray(result)) tags.push(...result);
        else {
            if (result.html) html = result.html;
            if (result.tags) tags.push(...result.tags);
        }
    }
    return tags.length ? inject(html, tags) : html;
}

export function buildHtmlPlugin(config: any, getState: StateLookup): any {
    const pages = new Map<string, string>();
    const inlineScripts = new Map<string, string>();
    return {
        name: 'vite:build-html',
        resolveId(id: string) {
            return id.includes(PROXY) ? id : null;
        },
        load(id: string) {
            return inlineScripts.has(id) ? { code: inlineScripts.get(id)!, moduleType: 'js' } : null;
        },
        transform: {
            filter: { id: /\.html$/ },
            async handler(this: any, code: string, id: string) {
                const file = cleanUrl(id);
                const relative = normalizePath(path.relative(config.root, file));
                const html = await applyHooks(hooksOf(config, 'pre'), code, { path: '/' + relative, filename: file });
                const imports: string[] = [];
                // `/x` is root-relative, unless it is already a path inside the
                // root (plugins write virtual entries' absolute paths into pages).
                const fromHtml = (src: string) =>
                    !src.startsWith('/') ? path.resolve(path.dirname(file), src) : src.startsWith(normalizePath(config.root) + '/') ? src : path.join(config.root, src);
                let index = 0;
                let stripped = html.replace(SCRIPT_RE, (match, attrs: string, body: string) => {
                    if (ATTR(attrs, 'type') !== 'module') return match;
                    const src = ATTR(attrs, 'src');
                    if (src && /^(https?:)?\/\//.test(src)) return match;
                    if (src) imports.push(fromHtml(src));
                    else {
                        const proxyId = `${file}${PROXY}${index++}.js`;
                        inlineScripts.set(proxyId, body);
                        imports.push(proxyId);
                    }
                    return '';
                });
                stripped = stripped.replace(STYLESHEET_RE, (match, attrs: string) => {
                    const href = ATTR(attrs, 'href');
                    if (!href || /^(https?:)?\/\//.test(href) || (config.publicDir && href.startsWith('/') && !href.startsWith('/src/'))) return match;
                    imports.push(fromHtml(href));
                    return '';
                });
                pages.set(file, stripped);
                return { code: imports.map((s) => `import ${JSON.stringify(s)};`).join('\n') || 'export {};', map: null, moduleType: 'js' };
            },
        },
        async generateBundle(this: any, _options: any, bundle: Record<string, any>) {
            const state = getState(this);
            const base = config.base === './' ? './' : config.base;
            const url = (fileName: string, htmlFile: string) =>
                base === './' ? normalizePath(path.relative(path.dirname(htmlFile), fileName)) || fileName : base.replace(/\/?$/, '/') + fileName;
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== 'chunk' || !chunk.facadeModuleId) continue;
                const file = cleanUrl(chunk.facadeModuleId);
                const page = pages.get(file);
                if (page === undefined) continue;
                const htmlFile = normalizePath(path.relative(config.root, file));
                const tags: any[] = [{ tag: 'script', attrs: { type: 'module', crossorigin: true, src: url(chunk.fileName, htmlFile) }, injectTo: 'head' }];
                const seen = new Set<string>();
                const css = new Set<string>();
                const walk = (name: string, isEntry: boolean) => {
                    if (seen.has(name)) return;
                    seen.add(name);
                    const c = bundle[name];
                    if (!c || c.type !== 'chunk') return;
                    for (const sheet of state.metaFor(c).importedCss) css.add(sheet);
                    if (!isEntry) tags.push({ tag: 'link', attrs: { rel: 'modulepreload', crossorigin: true, href: url(name, htmlFile) }, injectTo: 'head' });
                    for (const imported of c.imports) walk(imported, false);
                };
                walk(chunk.fileName, true);
                for (const sheet of css) tags.push({ tag: 'link', attrs: { rel: 'stylesheet', crossorigin: true, href: url(sheet, htmlFile) }, injectTo: 'head' });
                let html = inject(page, tags);
                html = await applyHooks(hooksOf(config, 'post'), html, { path: '/' + htmlFile, filename: file, bundle, chunk });
                this.emitFile({ type: 'asset', fileName: htmlFile, source: html });
            }
        },
    };
}
