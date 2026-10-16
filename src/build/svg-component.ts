/**
 * An SVG file as a component, built in (no SVGR):
 * `import Logo from './logo.svg?react'` (React, Preact) or `?component` (the
 * app's framework, Vue included). The root `<svg>`'s attributes become props
 * the caller can override (`<Logo className="icon" width={24} />`); its content
 * is set as-is, so gradients, ids and `<use>` references keep working.
 */

export type SvgRuntime = 'react' | 'preact' | 'vue';

export const SVG_COMPONENT_QUERY = /[?&](react|component)\b/;

export function svgRuntimeFor(framework: string | undefined, query: string): SvgRuntime | null {
    if (/[?&]react\b/.test(query)) return framework === 'preact' ? 'preact' : 'react';
    if (framework === 'react' || framework === 'preact' || framework === 'vue') return framework;
    return null;
}

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parse(svg: string): { attrs: Record<string, string>; inner: string } {
    const source = svg.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    const open = /<svg\b([^>]*?)(\/?)>/i.exec(source);
    if (!open) throw new Error('no <svg> element');
    const attrs: Record<string, string> = {};
    for (const m of open[1]!.matchAll(ATTR)) attrs[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
    if (open[2]) return { attrs, inner: '' };
    const start = open.index + open[0].length;
    const end = source.toLowerCase().lastIndexOf('</svg>');
    return { attrs, inner: source.slice(start, end < start ? undefined : end).trim() };
}

const camel = (name: string) => name.replace(/[-:]([a-z])/g, (_m, c: string) => c.toUpperCase());

/** DOM attribute names as React props: `class` → `className`, `stroke-width` → `strokeWidth`, `xlink:href` → `xlinkHref`. */
function reactProps(attrs: Record<string, string>): Record<string, unknown> {
    const props: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(attrs)) {
        if (name === 'class') props.className = value;
        else if (name === 'style') {
            const style: Record<string, string> = {};
            for (const decl of value.split(';')) {
                const i = decl.indexOf(':');
                if (i > 0) style[camel(decl.slice(0, i).trim())] = decl.slice(i + 1).trim();
            }
            props.style = style;
        } else if (/^(data|aria)-/.test(name)) props[name] = value;
        else props[camel(name)] = value;
    }
    return props;
}

export function svgComponent(svg: string, runtime: SvgRuntime): string {
    const { attrs, inner } = parse(svg);
    const html = JSON.stringify(inner);
    if (runtime === 'react') {
        return `import { createElement, forwardRef } from 'react';
const attrs = ${JSON.stringify(reactProps(attrs))};
const SvgComponent = forwardRef(function SvgComponent(props, ref) {
  return createElement('svg', { ...attrs, ...props, ref, dangerouslySetInnerHTML: { __html: ${html} } });
});
export default SvgComponent;
`;
    }
    if (runtime === 'preact') {
        return `import { h } from 'preact';
const attrs = ${JSON.stringify(attrs)};
export default function SvgComponent(props) {
  return h('svg', { ...attrs, ...props, dangerouslySetInnerHTML: { __html: ${html} } });
}
`;
    }
    return `import { defineComponent, h } from 'vue';
const attrs = ${JSON.stringify(attrs)};
export default defineComponent({
  name: 'SvgComponent',
  inheritAttrs: false,
  setup(_props, { attrs: passed }) {
    return () => h('svg', { ...attrs, ...passed, innerHTML: ${html} });
  },
});
`;
}
