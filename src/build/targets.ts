/**
 * Which browsers a build targets, for the JS syntax Oxc lowers and the CSS
 * LightningCSS prefixes and lowers.
 *
 *  - `build.target` (as in Vite): `'es2020'`, `['chrome90', 'safari14']`,
 *    `'baseline-widely-available'`, `'modules'`, or `'esnext'` (no lowering);
 *  - otherwise the project's browserslist (`browserslist` in package.json or a
 *    `.browserslistrc`), as Rsbuild and Parcel read it;
 *  - otherwise Vite's default, `baseline-widely-available` (Chrome / Edge 111,
 *    Firefox 114, Safari 16.4): CSS nesting is lowered for Safari 16, say.
 *    Almost all JS syntax those support is kept as written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export interface BuildTargets {
    /** Oxc targets (`es2020`, `chrome90`…); null keeps the syntax as written. */
    js: string[] | null;
    /** LightningCSS targets; null leaves CSS to the browsers that support it as written. */
    css: Record<string, number> | null;
}

/** Vite's named targets. */
const NAMED: Record<string, string[]> = {
    'baseline-widely-available': ['chrome111', 'edge111', 'firefox114', 'safari16.4'],
    modules: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
};

/** browserslist names → Oxc engine names. */
const ENGINE: Record<string, string> = {
    chrome: 'chrome', and_chr: 'chrome', android: 'chrome', edge: 'edge', firefox: 'firefox', and_ff: 'firefox',
    safari: 'safari', ios_saf: 'ios', opera: 'opera', op_mob: 'opera', samsung: 'samsung', ie: 'ie', node: 'node',
};
/** Oxc engine names → LightningCSS target keys. */
const CSS_KEY: Record<string, string> = { chrome: 'chrome', edge: 'edge', firefox: 'firefox', safari: 'safari', ios: 'ios_saf', opera: 'opera', samsung: 'samsung', ie: 'ie' };

export function resolveTargets(root: string, target?: string | string[] | false | null, cssTarget?: string | string[] | false | null): BuildTargets {
    const js = target === undefined || target === null ? fromBrowserslist(root) ?? NAMED['baseline-widely-available']! : normalize(target);
    const css = cssTarget === undefined || cssTarget === null ? js : normalize(cssTarget);
    return { js, css: css ? cssTargets(css) : null };
}

function normalize(target: string | string[] | false): string[] | null {
    if (target === false) return null;
    const list = (Array.isArray(target) ? target : [target]).flatMap((t) => NAMED[t.trim().toLowerCase()] ?? [t.trim().toLowerCase()]);
    if (list.length === 0 || list.includes('esnext')) return null;
    return list.map((t) => t.replace(/\s+/g, ''));
}

/** The project's browserslist query, resolved with its own `browserslist` package; null without one. */
function fromBrowserslist(root: string): string[] | null {
    let configured = !!process.env.BROWSERSLIST || fs.existsSync(path.join(root, '.browserslistrc'));
    if (!configured) {
        try {
            configured = 'browserslist' in JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        } catch {
            configured = false;
        }
    }
    if (!configured) return null;
    let browserslist: any;
    try {
        browserslist = createRequire(path.join(root, 'package.json'))('browserslist');
    } catch {
        try {
            browserslist = createRequire(import.meta.url)('browserslist');
        } catch {
            return null;
        }
    }
    const min = new Map<string, number[]>();
    for (const entry of browserslist(undefined, { path: root, env: 'production' }) as string[]) {
        const [name, version] = entry.split(' ');
        const engine = ENGINE[name!];
        const parsed = version?.split('-')[0]?.split('.').map(Number);
        if (!engine || !parsed || parsed.some(Number.isNaN)) continue;
        const known = min.get(engine);
        if (!known || compare(parsed, known) < 0) min.set(engine, parsed);
    }
    return min.size ? [...min].map(([engine, v]) => `${engine}${v.join('.')}`) : null;
}

const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
};

/** `['chrome90', 'safari14.1', 'es2020']` → LightningCSS targets (ES versions say nothing about CSS). */
function cssTargets(list: string[]): Record<string, number> | null {
    const out: Record<string, number> = {};
    for (const t of list) {
        const m = /^([a-z]+)(\d+(?:\.\d+){0,2})$/.exec(t);
        if (!m || m[1] === 'es') continue;
        const key = CSS_KEY[m[1]!];
        if (!key) continue;
        const [major = 0, minor = 0, patch = 0] = m[2]!.split('.').map(Number);
        const value = (major << 16) | (minor << 8) | patch;
        if (out[key] === undefined || value < out[key]!) out[key] = value;
    }
    return Object.keys(out).length ? out : null;
}
