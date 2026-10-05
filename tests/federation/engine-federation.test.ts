/**
 * Module federation on lunx's engine: a remote exposing modules and a host
 * consuming them, built by the production bundler.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

// Rolldown checks plugin filters with native RegExp, which Jest's VM realm
// does not share, so each build runs in its own Node process.
async function productionBuild(cfg: any, framework: string): Promise<void> {
    const script = path.join(dir, `build-${path.basename(cfg.root)}.mts`);
    const production = pathToFileURL(path.resolve(process.cwd(), 'src/build/production.ts')).href;
    fs.writeFileSync(script, `import { productionBuild } from ${JSON.stringify(production)};\nawait productionBuild(${JSON.stringify(cfg)}, ${JSON.stringify(framework)});\n`);
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    if (result.status !== 0) throw new Error(`build failed:\n${result.stdout}\n${result.stderr}`);
}

const repoModules = path.resolve(process.cwd(), 'node_modules');
let dir: string;

function write(file: string, content: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function app(name: string): string {
    const root = path.join(dir, name);
    write(path.join(root, 'package.json'), JSON.stringify({ name, type: 'module', dependencies: { react: '^19.0.0' } }));
    fs.symlinkSync(repoModules, path.join(root, 'node_modules'), 'dir');
    return root;
}

const config = (root: string, federation: any): any => ({
    root,
    outDir: 'dist',
    mode: 'production',
    platform: 'browser',
    preset: 'spa',
    build: { compress: false, minify: false },
    federation,
});

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-mf-'));
});

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('module federation (engine)', () => {
    let remoteRoot: string;

    it('builds a remote container with exposed modules and shared deps', async () => {
        remoteRoot = app('remote');
        write(path.join(remoteRoot, 'src/utils.ts'), 'import { version } from "react";\nexport const add = (a: number, b: number) => a + b;\nexport const reactVersion = version;\n');
        write(path.join(remoteRoot, 'src/Card.tsx'), 'import "./card.css";\nexport default function Card() { return <div className="card" />; }\n');
        write(path.join(remoteRoot, 'src/card.css'), '.card { color: red; }\n');
        await productionBuild(config(remoteRoot, {
            name: 'remote',
            exposes: { './utils': './src/utils.ts', './Card': './src/Card.tsx' },
            shared: { react: { singleton: true } },
        }), 'react');

        const out = path.join(remoteRoot, 'dist');
        const entry = fs.readFileSync(path.join(out, 'remoteEntry.js'), 'utf8');
        expect(entry).toContain('export function init');
        expect(entry).toContain('export async function get');
        const manifest = JSON.parse(fs.readFileSync(path.join(out, 'mf-manifest.json'), 'utf8'));
        expect(Object.keys(manifest.exposes)).toEqual(['./utils', './Card']);
        expect(manifest.shared.react.singleton).toBe(true);
        expect(manifest.shared.react.requiredVersion).toBe('^19.0.0');
        expect(manifest.css.length).toBe(1);
        // No page for a remote-only project.
        expect(fs.existsSync(path.join(out, 'index.html'))).toBe(false);
    }, 60000);

    it('serves exposed modules through the container API', async () => {
        const probe = path.join(dir, 'probe.mjs');
        fs.writeFileSync(probe, `
const c = await import(${JSON.stringify(pathToFileURL(path.join(remoteRoot, 'dist/remoteEntry.js')).href)});
c.init({});
const mod = (await c.get('./utils'))();
let missing = '';
await c.get('./missing').catch((e) => { missing = e.message; });
console.log(JSON.stringify({ sum: mod.add(2, 3), react: mod.reactVersion, missing, scope: Object.keys(globalThis.__lunx_mf_scopes__.default) }));
`);
        const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
        expect(result.stderr).toBe('');
        const out = JSON.parse(result.stdout);
        expect(out.sum).toBe(5);
        expect(out.react).toMatch(/^19\./);
        expect(out.missing).toMatch(/not exposed/);
        expect(out.scope).toEqual(['react']);
    }, 60000);

    it('builds a host that loads remotes and waits for the share scope', async () => {
        const hostRoot = app('host');
        write(path.join(hostRoot, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>');
        write(path.join(hostRoot, 'src/main.ts'), [
            'import { add } from "remote/utils";',
            'import { useState } from "react";',
            'const lazy = () => import("remote/Card");',
            'console.log(add(1, 2), useState, lazy);',
        ].join('\n'));
        await productionBuild(config(hostRoot, {
            name: 'host',
            remotes: { remote: 'remote@http://localhost:4174/remoteEntry.js' },
            shared: ['react'],
        }), 'react');

        const assets = path.join(hostRoot, 'dist/assets');
        const code = fs.readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n');
        expect(code).toContain('http://localhost:4174/remoteEntry.js');
        expect(code).toContain('await ensureShared()');
        expect(code).toContain('await loadRemote("remote/utils")');
        expect(code).toContain('loadRemote("remote/Card")');
        expect(code).not.toMatch(/from\s*["']remote\//);
        expect(fs.existsSync(path.join(hostRoot, 'dist/remoteEntry.js'))).toBe(false);
    }, 60000);
});
