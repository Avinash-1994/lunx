/**
 * `html` in lunx.config, applied to every page in dev and in builds (as
 * Rsbuild's `html` options and Vite's `html.cspNonce`):
 *
 *   html: {
 *     title: 'My app',
 *     meta: { description: '…', 'theme-color': '#fff' },
 *     favicon: '/favicon.svg',
 *     preconnect: ['https://api.example.com'],
 *     dnsPrefetch: ['https://cdn.example.com'],
 *     tags: [{ tag: 'script', attrs: { src: 'https://…' }, injectTo: 'body' }],
 *     cspNonce: 'abc123',
 *   }
 */

export interface HtmlTag {
    tag: string;
    attrs?: Record<string, string | boolean>;
    children?: string;
    /** Where the tag goes (default 'head'). */
    injectTo?: 'head' | 'head-prepend' | 'body' | 'body-prepend';
}

export interface HtmlOptions {
    title?: string;
    meta?: Record<string, string>;
    favicon?: string;
    preconnect?: string[];
    dnsPrefetch?: string[];
    tags?: HtmlTag[];
    /** Added to every script, style and stylesheet link, and as `<meta property="csp-nonce">` (Vite's `html.cspNonce`). */
    cspNonce?: string;
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function renderTag(t: HtmlTag): string {
    const attrs = Object.entries(t.attrs ?? {})
        .filter(([, v]) => v !== false)
        .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(String(v))}"`))
        .join('');
    const voidTag = /^(meta|link|base|br|hr|img|input)$/i.test(t.tag);
    return voidTag ? `<${t.tag}${attrs}>` : `<${t.tag}${attrs}>${t.children ?? ''}</${t.tag}>`;
}

/** The page with the `html` options applied; `base` prefixes a root-relative favicon. */
export function applyHtmlOptions(page: string, options: HtmlOptions | undefined, base = '/'): string {
    if (!options) return page;
    const head: string[] = [];
    const headPrepend: string[] = [];
    const body: string[] = [];
    const bodyPrepend: string[] = [];
    if (options.title !== undefined) {
        if (/<title>[\s\S]*?<\/title>/i.test(page)) page = page.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(options.title)}</title>`);
        else head.push(`<title>${esc(options.title)}</title>`);
    }
    for (const [name, content] of Object.entries(options.meta ?? {})) {
        const existing = new RegExp(`<meta\\b[^>]*\\bname=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
        const tag = `<meta name="${esc(name)}" content="${esc(content)}">`;
        if (existing.test(page)) page = page.replace(existing, tag);
        else head.push(tag);
    }
    if (options.favicon) {
        const href = options.favicon.startsWith('/') ? base + options.favicon.slice(1) : options.favicon;
        page = page.replace(/<link\b[^>]*\brel=["'](?:shortcut )?icon["'][^>]*>\s*/gi, '');
        head.push(`<link rel="icon" href="${esc(href)}">`);
    }
    for (const origin of options.preconnect ?? []) head.push(`<link rel="preconnect" href="${esc(origin)}" crossorigin>`);
    for (const origin of options.dnsPrefetch ?? []) head.push(`<link rel="dns-prefetch" href="${esc(origin)}">`);
    for (const t of options.tags ?? []) {
        const at = t.injectTo ?? 'head';
        (at === 'head' ? head : at === 'head-prepend' ? headPrepend : at === 'body' ? body : bodyPrepend).push(renderTag(t));
    }
    if (options.cspNonce) head.push(`<meta property="csp-nonce" nonce="${esc(options.cspNonce)}">`);
    const lines = (tags: string[]) => tags.map((t) => `    ${t}\n`).join('');
    if (headPrepend.length) page = /<head[^>]*>/i.test(page) ? page.replace(/<head[^>]*>/i, (m) => `${m}\n${lines(headPrepend)}`) : lines(headPrepend) + page;
    if (head.length) page = /<\/head>/i.test(page) ? page.replace(/<\/head>/i, `${lines(head)}  </head>`) : lines(head) + page;
    if (bodyPrepend.length) page = /<body[^>]*>/i.test(page) ? page.replace(/<body[^>]*>/i, (m) => `${m}\n${lines(bodyPrepend)}`) : page + lines(bodyPrepend);
    if (body.length) page = /<\/body>/i.test(page) ? page.replace(/<\/body>/i, `${lines(body)}  </body>`) : page + lines(body);
    if (options.cspNonce) page = addNonce(page, options.cspNonce);
    return page;
}

/** `nonce` on every script, style and stylesheet / preload link that has none. */
export function addNonce(page: string, nonce: string): string {
    return page.replace(/<(script|style|link)\b([^>]*)>/gi, (m, tag: string, attrs: string) => {
        if (/\bnonce=/i.test(attrs)) return m;
        if (tag.toLowerCase() === 'link' && !/\brel=["']?(stylesheet|modulepreload|preload)\b/i.test(attrs)) return m;
        const selfClosing = /\/\s*$/.test(attrs);
        return `<${tag}${attrs.replace(/\s*\/\s*$/, '')} nonce="${esc(nonce)}"${selfClosing ? ' /' : ''}>`;
    });
}
