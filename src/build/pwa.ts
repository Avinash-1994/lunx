/**
 * Progressive web app, built in (no vite-plugin-pwa, no Workbox): with `pwa`
 * in lunx.config, `lunx build` writes
 *
 *  - `manifest.webmanifest` from `pwa.manifest`, linked from every page;
 *  - `registerSW.js`, which registers the service worker (an external script,
 *    so lunx's `script-src 'self'` CSP allows it);
 *  - `sw.js`, written last, once the pages carry their SRI: it precaches the
 *    whole build, serves it cache-first, falls back to `index.html` for
 *    navigations offline (single-page apps), and replaces the previous cache
 *    when a new build is deployed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface PwaOptions {
    /** The web app manifest (name, short_name, icons, theme_color…), or `false` for none. */
    manifest?: Record<string, unknown> | false;
    /** Register the service worker from every page. Default: true. */
    register?: boolean;
    /** The page offline navigations fall back to; `null` for none. Default: `index.html`. */
    navigateFallback?: string | null;
    /** Build files to leave out of the precache, besides maps, compressed copies and lunx's reports. */
    exclude?: Array<string | RegExp>;
}

export const SW_FILE = 'sw.js';
const REGISTER_FILE = 'registerSW.js';
const MANIFEST_FILE = 'manifest.webmanifest';

export function pwaOptions(value: unknown): PwaOptions | null {
    if (!value) return null;
    return value === true ? {} : (value as PwaOptions);
}

/** The tags each page gets in its `<head>`. */
export function pwaHeadTags(options: PwaOptions, base: string): string[] {
    return [
        ...(options.manifest !== false ? [`<link rel="manifest" href="${base}${MANIFEST_FILE}">`] : []),
        ...(options.register !== false ? [`<script src="${base}${REGISTER_FILE}" defer></script>`] : []),
    ];
}

/** `manifest.webmanifest` and `registerSW.js`, written with the pages. */
export function pwaFiles(options: PwaOptions, base: string): Array<{ fileName: string; source: string }> {
    const files: Array<{ fileName: string; source: string }> = [];
    if (options.manifest !== false) {
        const manifest = { start_url: base, scope: base, display: 'standalone', ...(options.manifest ?? {}) };
        files.push({ fileName: MANIFEST_FILE, source: JSON.stringify(manifest, null, 2) + '\n' });
    }
    if (options.register !== false) {
        files.push({
            fileName: REGISTER_FILE,
            source: `if ('serviceWorker' in navigator) {\n  window.addEventListener('load', () => navigator.serviceWorker.register(${JSON.stringify(base + SW_FILE)}, { scope: ${JSON.stringify(base)} }));\n}\n`,
        });
    }
    return files;
}

const SKIP = [/\.map$/, /\.(gz|br)$/, /^lunx-[\w-]+\.(json|txt|html)$/, /^_(headers|redirects)$/, /^\.htaccess$/];

function filesIn(dir: string, root = dir): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...filesIn(full, root));
        else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
    return out;
}

/** `sw.js`, from the build as it is on disk. Returns the number of files it precaches. */
export function writeServiceWorker(outDir: string, options: PwaOptions): number {
    const exclude = [...SKIP, ...(options.exclude ?? []).map((e) => (typeof e === 'string' ? new RegExp(`^${e.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`) : e))];
    const files = filesIn(outDir)
        .filter((f) => f !== SW_FILE && !exclude.some((re) => re.test(f) || re.test(path.posix.basename(f))))
        .sort();
    const all = crypto.createHash('sha256');
    const precache = files.map((file) => {
        const revision = crypto.createHash('sha256').update(fs.readFileSync(path.join(outDir, file))).digest('hex').slice(0, 12);
        all.update(file).update(revision);
        return `./${file}`;
    });
    const fallback = options.navigateFallback === undefined ? 'index.html' : options.navigateFallback;
    const source = `// Written by lunx (pwa in lunx.config): precaches the build, serves it cache-first.
const CACHE = 'lunx-precache-${all.digest('hex').slice(0, 12)}';
const PRECACHE = ${JSON.stringify(precache)};
const FALLBACK = ${JSON.stringify(fallback && files.includes(fallback) ? `./${fallback}` : null)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('lunx-precache-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = url.pathname.endsWith('/') ? new URL('index.html', url) : request;
    const hit = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    try {
      return await fetch(request);
    } catch (err) {
      if (request.mode === 'navigate' && FALLBACK) {
        const page = await cache.match(new URL(FALLBACK, self.registration.scope));
        if (page) return page;
      }
      throw err;
    }
  })());
});
`;
    fs.writeFileSync(path.join(outDir, SW_FILE), source);
    return precache.length;
}
