/**
 * Build-time counterparts of the dev plugins: CSS extracted per chunk (with
 * `chunk.viteMetadata.importedCss`), hashed assets, and Vite's
 * `.vite/manifest.json`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compileCss, isCssModule } from '../../build/css.js';
import { cleanUrl, isCSSRequest, normalizePath } from '../utils.js';
import { isAssetRequest } from './asset.js';

const SKIP_RE = /[?&](?:worker|sharedworker|raw|url)\b/;
const INLINE_RE = /[?&]inline\b/;
const ASSET_PLACEHOLDER_RE = /(["'`])__VITE_ASSET__([a-f0-9]+)__\1|__VITE_ASSET__([a-f0-9]+)__/g;

const MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

export interface ViteMetadata {
    importedCss: Set<string>;
    importedAssets: Set<string>;
}

/** Shared state of one build: emitted assets and per-chunk metadata. */
export class BuildState {
    /** placeholder id → output file name */
    readonly assets = new Map<string, { fileName: string; source: Buffer | string; originalFileName?: string }>();
    /** module id → asset placeholder ids it references */
    readonly moduleAssets = new Map<string, Set<string>>();
    readonly styles = new Map<string, string>();
    readonly chunkMeta = new Map<string, ViteMetadata>();

    constructor(public config: any, public ssr: boolean, public assetFileNames: any) {}

    /** The file name Rollup's `assetFileNames` pattern gives this source. */
    assetFileName(name: string, source: Buffer | string, originalFileName?: string): string {
        const hash = crypto.createHash('sha256').update(source).digest('base64url').replace(/[-_]/g, '').slice(0, 8);
        const pattern = typeof this.assetFileNames === 'function'
            ? this.assetFileNames({ type: 'asset', name, names: [name], originalFileName, originalFileNames: originalFileName ? [originalFileName] : [], source })
            : this.assetFileNames ?? `${this.config.build.assetsDir}/[name]-[hash][extname]`;
        const ext = path.extname(name);
        return pattern
            .replace(/\[name\]/g, path.basename(name, ext))
            .replace(/\[hash(?::\d+)?\]/g, hash)
            .replace(/\[extname\]/g, ext)
            .replace(/\[ext\]/g, ext.slice(1));
    }

    addAsset(name: string, source: Buffer | string, originalFileName?: string): string {
        const fileName = this.assetFileName(name, source, originalFileName);
        const id = crypto.createHash('md5').update(fileName).digest('hex').slice(0, 12);
        this.assets.set(id, { fileName, source, originalFileName });
        return id;
    }

    /** Asset URL for code or CSS emitted at `fromFile`. */
    assetUrl(fileName: string, fromFile: string, inJs: boolean): string {
        const base = this.config.base;
        if (base === './' || base === '') {
            const rel = path.posix.relative(path.posix.dirname(fromFile), fileName);
            const relative = rel.startsWith('.') ? rel : `./${rel}`;
            return inJs ? `new URL(${JSON.stringify(relative)}, import.meta.url).href` : relative;
        }
        const url = base.replace(/\/?$/, '/') + fileName;
        return inJs ? JSON.stringify(url) : url;
    }

    replacePlaceholders(code: string, fromFile: string, inJs: boolean): string {
        if (!code.includes('__VITE_ASSET__')) return code;
        return code.replace(ASSET_PLACEHOLDER_RE, (match, _q, quotedId, bareId) => {
            const asset = this.assets.get(quotedId ?? bareId);
            if (!asset) return match;
            if (quotedId) return this.assetUrl(asset.fileName, fromFile, inJs);
            const url = this.assetUrl(asset.fileName, fromFile, false);
            return inJs ? url.replace(/"/g, '\\"') : url;
        });
    }

    metaFor(chunk: { name: string; moduleIds: string[] }): ViteMetadata {
        const key = `${chunk.name}|${chunk.moduleIds.join(',')}`;
        let meta = this.chunkMeta.get(key);
        if (!meta) this.chunkMeta.set(key, (meta = { importedCss: new Set(), importedAssets: new Set() }));
        return meta;
    }
}

export function cssBuildPlugins(state: BuildState): any[] {
    const { config } = state;
    let globalCss = '';
    return [
        {
            name: 'vite:css',
            transform: {
                filter: { id: /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/ },
                async handler(this: any, code: string, id: string) {
                    if (!isCSSRequest(id) || SKIP_RE.test(id)) return null;
                    const file = cleanUrl(id);
                    const compiled = await compileCss({
                        root: config.root,
                        file: /\.(css|pcss|postcss|scss|sass|less|styl|stylus)$/i.test(file) ? file : file + '.css',
                        source: code,
                        modules: isCssModule(file) || /[?&]lang\.module\.\w+/.test(id),
                        minify: false,
                        resolveUrl: (from, url) => {
                            if (/^(data:|https?:|\/\/|#)/.test(url)) return url;
                            const [clean] = url.split(/[?#]/);
                            const target = clean!.startsWith('/')
                                ? [path.join(config.publicDir || '', clean!), path.join(config.root, clean!)].find((f) => f && fs.existsSync(f))
                                : path.resolve(path.dirname(from), clean!);
                            if (!target || !fs.existsSync(target)) return url;
                            if (config.publicDir && target.startsWith(config.publicDir + path.sep)) return url;
                            const source = fs.readFileSync(target);
                            if (source.length < (config.build.assetsInlineLimit ?? 4096) && !target.endsWith('.svg')) {
                                return `data:${MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'};base64,${source.toString('base64')}`;
                            }
                            const ref = state.addAsset(path.basename(target), source, normalizePath(path.relative(config.root, target)));
                            return `__VITE_ASSET__${ref}__`;
                        },
                    });
                    for (const dep of compiled.dependencies) if (dep !== file && path.isAbsolute(dep)) this.addWatchFile(dep);
                    const modules = compiled.exports;
                    const modulesCode = modules
                        ? [
                              `const __modules__ = ${JSON.stringify(modules)};`,
                              'export default __modules__;',
                              ...Object.keys(modules).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k)).map((k) => `export const ${k} = __modules__[${JSON.stringify(k)}];`),
                          ].join('\n')
                        : '';
                    if (INLINE_RE.test(id)) return { code: `export default ${JSON.stringify(compiled.code)};`, map: null, moduleType: 'js' };
                    state.styles.set(id, compiled.code);
                    return { code: modulesCode || 'export default "";', map: null, moduleType: 'js', moduleSideEffects: 'no-treeshake' };
                },
            },
        },
        {
            name: 'vite:css-post',
            async renderChunk(this: any, code: string, chunk: any) {
                const meta = state.metaFor(chunk);
                let css = '';
                for (const id of chunk.moduleIds) {
                    const style = state.styles.get(id);
                    if (style) css += style + '\n';
                    for (const ref of state.moduleAssets.get(id) ?? []) meta.importedAssets.add(state.assets.get(ref)!.fileName);
                }
                if (css) {
                    if (config.build.cssCodeSplit !== false) {
                        const fileName = state.assetFileName(`${chunk.name}.css`, css);
                        let out = state.replacePlaceholders(css, fileName, false);
                        if (config.build.cssMinify !== false && config.build.minify !== false) out = await minifyCss(out, fileName);
                        this.emitFile({ type: 'asset', fileName, source: out });
                        meta.importedCss.add(fileName);
                    } else {
                        globalCss += css;
                    }
                }
                const fileName = chunk.fileName ?? chunk.name;
                const next = state.replacePlaceholders(code, fileName, true);
                chunk.viteMetadata = meta;
                return next === code ? null : { code: next, map: null };
            },
            async generateBundle(this: any, _options: any, bundle: Record<string, any>) {
                if (globalCss) {
                    const fileName = state.assetFileName(`${config.build.cssFileName || 'style'}.css`, globalCss);
                    let out = state.replacePlaceholders(globalCss, fileName, false);
                    if (config.build.cssMinify !== false && config.build.minify !== false) out = await minifyCss(out, fileName);
                    this.emitFile({ type: 'asset', fileName, source: out });
                    for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk' && chunk.isEntry) state.metaFor(chunk).importedCss.add(fileName);
                }
                for (const asset of state.assets.values()) this.emitFile({ type: 'asset', fileName: asset.fileName, source: asset.source, originalFileName: asset.originalFileName });
                for (const chunk of Object.values(bundle)) {
                    if (chunk.type === 'chunk') attachMeta(chunk, state.metaFor(chunk));
                }
            },
        },
    ];
}

function attachMeta(chunk: any, meta: ViteMetadata): void {
    try {
        Object.defineProperty(chunk, 'viteMetadata', { value: meta, configurable: true, enumerable: false, writable: true });
    } catch {
        chunk.viteMetadata = meta;
    }
}

async function minifyCss(css: string, fileName: string): Promise<string> {
    const { transform } = await import('lightningcss');
    try {
        return transform({ filename: fileName, code: Buffer.from(css), minify: true, errorRecovery: true } as any).code.toString();
    } catch {
        return css;
    }
}

export function assetBuildPlugin(state: BuildState): any {
    const { config } = state;
    return {
        name: 'vite:asset',
        load(this: any, id: string) {
            if (id.startsWith('\0')) return null;
            const file = cleanUrl(id);
            if (!path.isAbsolute(file) || !fs.existsSync(file)) return null;
            if (/[?&]raw\b/.test(id)) return { code: `export default ${JSON.stringify(fs.readFileSync(file, 'utf-8'))};`, moduleType: 'js' };
            const explicitUrl = /[?&]url\b/.test(id);
            if (!explicitUrl && (!isAssetRequest(config, id) || isCSSRequest(id))) return null;
            if (config.publicDir && file.startsWith(config.publicDir + path.sep)) {
                return { code: `export default ${JSON.stringify(config.base.replace(/\/?$/, '/') + normalizePath(path.relative(config.publicDir, file)))};`, moduleType: 'js' };
            }
            const source = fs.readFileSync(file);
            const limit = typeof config.build.assetsInlineLimit === 'function' ? config.build.assetsInlineLimit(file, source) : source.length < (config.build.assetsInlineLimit ?? 4096);
            if ((/[?&]inline\b/.test(id) || (limit && !explicitUrl)) && !/[?&]no-inline\b/.test(id)) {
                const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
                return { code: `export default ${JSON.stringify(`data:${mime};base64,${source.toString('base64')}`)};`, moduleType: 'js' };
            }
            const ref = state.addAsset(path.basename(file), source, normalizePath(path.relative(config.root, file)));
            let refs = state.moduleAssets.get(id);
            if (!refs) state.moduleAssets.set(id, (refs = new Set()));
            refs.add(ref);
            return { code: `export default "__VITE_ASSET__${ref}__";`, moduleType: 'js' };
        },
    };
}

/** Vite's build manifest (`build.manifest`). */
export function manifestPlugin(state: BuildState): any {
    const { config } = state;
    return {
        name: 'vite:manifest',
        generateBundle: {
            order: 'post',
            handler(this: any, _options: any, bundle: Record<string, any>) {
                if (state.ssr && !config.build.ssrEmitAssets) {
                    for (const [fileName, item] of Object.entries(bundle)) if (item.type === 'asset') delete bundle[fileName];
                }
                if (!config.build.manifest) return;
                const keyFor = (chunk: any): string =>
                    chunk.facadeModuleId ? normalizePath(path.relative(config.root, chunk.facadeModuleId)).replace(/\0/g, '') : `_${path.basename(chunk.fileName)}`;
                const manifest: Record<string, any> = {};
                for (const item of Object.values(bundle)) {
                    if (item.type !== 'chunk') continue;
                    const meta: ViteMetadata = item.viteMetadata ?? state.metaFor(item);
                    const key = keyFor(item);
                    const entry: Record<string, any> = { file: item.fileName, name: item.name };
                    if (item.facadeModuleId) entry.src = key;
                    if (item.isEntry) entry.isEntry = true;
                    if (item.isDynamicEntry) entry.isDynamicEntry = true;
                    const imports = item.imports.filter((f: string) => bundle[f]?.type === 'chunk').map((f: string) => keyFor(bundle[f]));
                    const dynamicImports = item.dynamicImports.filter((f: string) => bundle[f]?.type === 'chunk').map((f: string) => keyFor(bundle[f]));
                    if (imports.length) entry.imports = imports;
                    if (dynamicImports.length) entry.dynamicImports = dynamicImports;
                    if (meta.importedCss.size) entry.css = [...meta.importedCss];
                    if (meta.importedAssets.size) entry.assets = [...meta.importedAssets];
                    manifest[key] = entry;
                }
                for (const asset of state.assets.values()) {
                    if (asset.originalFileName && !manifest[asset.originalFileName]) manifest[asset.originalFileName] = { file: asset.fileName, src: asset.originalFileName };
                }
                const fileName = typeof config.build.manifest === 'string' ? config.build.manifest : '.vite/manifest.json';
                this.emitFile({ type: 'asset', fileName, source: JSON.stringify(manifest, null, 2) });
            },
        },
    };
}
