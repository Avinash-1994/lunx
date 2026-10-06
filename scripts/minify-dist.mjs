#!/usr/bin/env node
/**
 * Minify the published JavaScript in place with Oxc (the minifier inside
 * Rolldown). Each file keeps its path, so everything lunx looks up by path
 * (the vite/rollup redirects, shims, workers) is unaffected; names are kept,
 * so error messages and stack traces stay readable.
 *
 * Skipped: files lunx serves to the browser or reads as text and patches
 * (their placeholders and line patterns must survive), and the workspace
 * packages' own builds.
 *
 *   node scripts/minify-dist.mjs [dist]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { minifySync } = require('rolldown/experimental');

const root = path.resolve(process.argv[2] ?? 'dist');
const SKIP = [
    /^runtime\//,              // HMR client, overlay, federation runtime: served to browsers
    /^plugin-host\/client\//,  // /@vite/client: read as text, placeholders replaced
    /^templates\//,            // project templates copied into new apps
];

let before = 0;
let after = 0;
let count = 0;
for (const rel of fs.readdirSync(root, { recursive: true })) {
    const file = path.join(root, rel);
    const posix = rel.split(path.sep).join('/');
    if (!/\.(js|mjs|cjs)$/.test(posix) || SKIP.some((re) => re.test(posix)) || !fs.statSync(file).isFile()) continue;
    const code = fs.readFileSync(file, 'utf8');
    const shebang = code.startsWith('#!') ? code.slice(0, code.indexOf('\n') + 1) : '';
    const result = minifySync(posix, code.slice(shebang.length), {
        compress: { keepNames: { function: true, class: true } },
        mangle: { keepNames: true, toplevel: false },
        sourcemap: false,
    });
    if (result.errors?.length) {
        console.warn(`[minify-dist] kept ${posix} as is: ${result.errors[0].message ?? result.errors[0]}`);
        continue;
    }
    const out = shebang + result.code;
    before += code.length;
    after += out.length;
    count++;
    fs.writeFileSync(file, out);
}
console.log(`[minify-dist] ${count} files: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);

// Types: only what the public entry (index.d.ts) reaches. The rest describe
// internals no consumer imports types from.
const seen = new Set();
const queue = [path.join(root, 'index.d.ts')];
while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const base = path.resolve(path.dirname(file), m[1]).replace(/\.js$/, '');
        const hit = [`${base}.d.ts`, path.join(base, 'index.d.ts')].find((c) => fs.existsSync(c));
        if (hit) queue.push(hit);
    }
}
let pruned = 0;
let prunedBytes = 0;
if (seen.size) {
    for (const rel of fs.readdirSync(root, { recursive: true })) {
        const file = path.join(root, rel);
        if (!/\.d\.[mc]?ts(\.map)?$/.test(rel) || seen.has(file.replace(/\.map$/, ''))) continue;
        prunedBytes += fs.statSync(file).size;
        fs.rmSync(file);
        pruned++;
    }
}
console.log(`[minify-dist] types: kept ${seen.size} public .d.ts, removed ${pruned} internal (${(prunedBytes / 1024).toFixed(0)} KB)`);
