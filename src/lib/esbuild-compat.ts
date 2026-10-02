/**
 * `transform()` with esbuild's option names, implemented on Oxc (JS/TS/JSX)
 * and LightningCSS (CSS), for call sites written against esbuild's API.
 */

import { createRequire } from 'node:module';
import { compile, minify as oxcMinify, type Lang } from './oxc.js';

const require = createRequire(import.meta.url);

export interface TransformOptions {
    loader?: 'js' | 'jsx' | 'ts' | 'tsx' | 'css' | string;
    jsx?: 'automatic' | 'transform' | 'preserve';
    jsxImportSource?: string;
    jsxFactory?: string;
    jsxFragment?: string;
    jsxDev?: boolean;
    define?: Record<string, string>;
    minify?: boolean;
    sourcemap?: boolean | 'inline' | 'external';
    sourcefile?: string;
    [key: string]: unknown;
}

export async function transform(code: string, opts: TransformOptions = {}): Promise<{ code: string; map: string; warnings: never[] }> {
    return transformSync(code, opts);
}

export function transformSync(code: string, opts: TransformOptions = {}): { code: string; map: string; warnings: never[] } {
    const loader = opts.loader ?? 'js';
    const file = opts.sourcefile ?? `input.${loader === 'css' ? 'css' : loader}`;
    if (loader === 'css') {
        const { transform: css } = require('lightningcss');
        const out = css({ filename: file, code: Buffer.from(code), minify: !!opts.minify });
        return { code: out.code.toString(), map: '', warnings: [] };
    }
    const lang = (['js', 'jsx', 'ts', 'tsx'].includes(loader) ? loader : 'js') as Lang;
    const jsx = opts.jsx === 'preserve'
        ? 'preserve' as const
        : {
              runtime: opts.jsx === 'transform' ? 'classic' as const : 'automatic' as const,
              importSource: opts.jsxImportSource,
              pragma: opts.jsxFactory,
              pragmaFrag: opts.jsxFragment,
              development: opts.jsxDev,
          };
    let out = compile(file, code, {
        lang,
        jsx,
        legacyDecorators: true,
        define: opts.define,
        sourcemap: opts.sourcemap === 'inline' ? 'inline' : !!opts.sourcemap,
    });
    if (opts.minify) out = oxcMinify(file, out.code);
    return { code: out.code, map: out.map ?? '', warnings: [] };
}
