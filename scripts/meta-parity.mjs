#!/usr/bin/env node
/**
 * Meta-framework build output, lunx against each framework's own CLI. Uses
 * the projects scripts/meta-matrix.mjs installs (run it first): each is built
 * by `lunx build`, then by its own build command, and the client output (what
 * browsers download: JS and CSS) is compared, gzip-9.
 *
 * Next.js and Docusaurus are left out: lunx runs their own CLI for them.
 *
 *   node scripts/meta-parity.mjs [--only=sveltekit,nuxt]
 *
 * Writes reports/META_PARITY.json.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'dist', 'cli.js');
const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',');

/** Own build command (a bin in node_modules/.bin), output dirs to clear, client dir to measure. */
const PROJECTS = [
    { name: 'sveltekit', native: ['vite', 'build'], outputs: ['.svelte-kit/output', 'build'], client: '.svelte-kit/output/client' },
    { name: 'nuxt', native: ['nuxt', 'build'], outputs: ['.output', '.nuxt/dist'], client: '.output/public' },
    { name: 'astro', native: ['astro', 'build'], outputs: ['dist'], client: 'dist' },
    { name: 'react-router', native: ['react-router', 'build'], outputs: ['build'], client: 'build/client' },
    { name: 'remix', native: ['remix', 'vite:build'], outputs: ['build'], client: 'build/client' },
    { name: 'vitepress', native: ['vitepress', 'build'], outputs: ['.vitepress/dist'], client: '.vitepress/dist' },
    { name: 'solidstart', native: ['vinxi', 'build'], outputs: ['.output', '.vinxi'], client: '.output/public' },
    { name: 'waku', native: ['waku', 'build'], outputs: ['dist'], client: 'dist/public' },
    { name: 'tanstack-start', native: ['vite', 'build'], outputs: ['dist', '.output'], client: 'dist/client' },
    { name: 'qwik-city', native: ['vite', 'build'], outputs: ['dist', 'server'], client: 'dist' },
    { name: 'marko-run', native: ['marko-run', 'build'], outputs: ['dist'], client: 'dist/public' },
    { name: 'analog', native: ['vite', 'build'], outputs: ['dist'], client: 'dist/analog/public' },
];

function run(cmd, args, cwd, env = {}) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000, env: { ...process.env, NO_COLOR: '1', ASTRO_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production', ...env }, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function filesIn(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...filesIn(full));
        else out.push(full);
    }
    return out;
}

function measure(dir) {
    // lunx's reports (lunx-*.json…) and server bundles are not what browsers download.
    const files = filesIn(dir).filter((f) => /\.(m?js|css)$/.test(f) && !/(^|\/)(lunx-[^/]*|_?server\/.*)$/.test(path.relative(dir, f).split(path.sep).join('/')));
    const gz = (f) => zlib.gzipSync(fs.readFileSync(f), { level: 9 }).length;
    const js = files.filter((f) => /\.m?js$/.test(f));
    const css = files.filter((f) => f.endsWith('.css'));
    return { jsFiles: js.length, jsGzip: js.reduce((n, f) => n + gz(f), 0), cssFiles: css.length, cssGzip: css.reduce((n, f) => n + gz(f), 0) };
}

const results = [];
for (const p of PROJECTS.filter((x) => !only || only.includes(x.name))) {
    const dir = path.join(os.tmpdir(), `lunx-meta-${p.name}`);
    const row = { name: p.name, lunx: null, native: null, losses: [] };
    if (!fs.existsSync(path.join(dir, 'node_modules'))) {
        row.losses.push('not installed: run scripts/meta-matrix.mjs first');
        results.push(row);
        console.log(`- ${p.name}: not installed`);
        continue;
    }
    for (const [tool, cmd, args] of [
        ['lunx', process.execPath, [CLI, 'build', '--root', dir]],
        ['native', path.join(dir, 'node_modules', '.bin', p.native[0]), p.native.slice(1)],
    ]) {
        for (const out of p.outputs) fs.rmSync(path.join(dir, out), { recursive: true, force: true });
        const started = Date.now();
        const r = run(cmd, args, tool === 'lunx' ? REPO : dir, tool === 'lunx' ? { LUNX_SKIP_SECURITY: '1', LUNX_BUILD_CACHE: '0' } : {});
        const ms = Date.now() - started;
        row[tool] = r.code === 0 ? { ms, ...measure(path.join(dir, p.client)) } : { error: r.output.trim().split('\n').slice(-4).join(' | ').slice(0, 400) };
    }
    const l = row.lunx;
    const n = row.native;
    if (l.error) row.losses.push(`lunx build failed: ${l.error}`);
    else if (!n.error) {
        if (l.jsFiles === 0 && n.jsFiles > 0) row.losses.push('no client JS found in the lunx build');
        if (l.jsGzip > n.jsGzip * 1.02 + 200) row.losses.push(`JS gzip ${l.jsGzip} vs ${n.jsGzip} (+${l.jsGzip - n.jsGzip} B)`);
        if (l.cssGzip > n.cssGzip * 1.02 + 50) row.losses.push(`CSS gzip ${l.cssGzip} vs ${n.cssGzip} (+${l.cssGzip - n.cssGzip} B)`);
    }
    results.push(row);
    const fmt = (m) => (m.error ? `FAILED (${m.error.slice(0, 160)})` : `js ${m.jsFiles} files ${m.jsGzip} B gz, css ${m.cssGzip} B gz, ${m.ms} ms`);
    console.log(`${row.losses.length ? '✗' : '✓'} ${p.name.padEnd(15)} lunx: ${fmt(l)} | own CLI: ${fmt(n)}`);
    for (const loss of row.losses) console.log(`    loss: ${loss}`);
}
fs.writeFileSync(path.join(REPO, 'reports', 'META_PARITY.json'), JSON.stringify({ node: process.version, results }, null, 2) + '\n');
const lost = results.filter((r) => r.losses.length).length;
console.log(`\n${results.length - lost}/${results.length} meta-frameworks with no loss to their own CLI`);
process.exitCode = lost ? 1 : 0;
