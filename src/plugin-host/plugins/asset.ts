/**
 * Static assets in dev: `?raw` (file contents), `?url` and known asset types
 * (their URL), `?inline` (a data URL).
 */

import fs from 'node:fs';
import path from 'node:path';
import { cleanUrl, FS_PREFIX, isCSSRequest, normalizePath } from '../utils.js';

export const KNOWN_ASSET_TYPES = [
    'apng', 'bmp', 'png', 'jpe?g', 'jfif', 'pjpeg', 'pjp', 'gif', 'svg', 'ico', 'webp', 'avif', 'cur', 'jxl',
    'mp4', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac', 'opus', 'mov', 'm4a', 'vtt',
    'woff2?', 'eot', 'ttf', 'otf', 'webmanifest', 'pdf', 'txt',
];
const ASSET_RE = new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})(\\?.*)?$`, 'i');

const MIME: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.txt': 'text/plain', '.pdf': 'application/pdf',
};

export function isAssetRequest(config: any, id: string): boolean {
    return ASSET_RE.test(id) || config.assetsInclude(cleanUrl(id));
}

export function fileToDevUrl(config: any, file: string): string {
    const rel = path.relative(config.root, file);
    const pathname = !rel.startsWith('..') && !path.isAbsolute(rel) ? '/' + normalizePath(rel) : FS_PREFIX + normalizePath(file).replace(/^\//, '');
    return config.base.replace(/\/$/, '') + pathname;
}

export function assetPlugin(config: any): any {
    return {
        name: 'vite:asset',
        load(id: string) {
            if (id.startsWith('\0')) return null;
            const file = cleanUrl(id);
            if (!path.isAbsolute(file) || !fs.existsSync(file)) return null;
            if (/[?&]raw\b/.test(id)) return `export default ${JSON.stringify(fs.readFileSync(file, 'utf-8'))};`;
            const explicitUrl = /[?&]url\b/.test(id);
            if (!explicitUrl && (!isAssetRequest(config, id) || isCSSRequest(id))) return null;
            if (/[?&]inline\b/.test(id)) {
                const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
                return `export default ${JSON.stringify(`data:${mime};base64,${fs.readFileSync(file).toString('base64')}`)};`;
            }
            const publicDir = config.publicDir;
            if (publicDir && file.startsWith(publicDir + path.sep)) {
                return `export default ${JSON.stringify(config.base.replace(/\/$/, '') + '/' + normalizePath(path.relative(publicDir, file)))};`;
            }
            return `export default ${JSON.stringify(fileToDevUrl(config, file))};`;
        },
    };
}
