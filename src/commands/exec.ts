/**
 * `lunx exec <tool> [args…]`: run a tool built on Vite — Storybook, Vitest,
 * Histoire, Slidev… — with `vite` (and Rollup, vite-node) pointing at lunx's
 * engine, in its process and the ones it starts. The tool's own CLI and
 * plugins run unchanged; no Vite or Rollup code runs.
 *
 *   lunx exec storybook dev -p 6006
 *   lunx exec storybook build
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runExec(argv: string[], cwd = process.cwd()): Promise<number> {
    const [tool, ...args] = argv;
    if (!tool) {
        console.error('Usage: lunx exec <tool> [args…]   e.g. lunx exec storybook dev');
        return 1;
    }
    const bin = findBin(tool, cwd);
    if (!bin) {
        console.error(`[lunx] "${tool}" is not installed in this project (no node_modules/.bin/${tool}).`);
        return 1;
    }
    const register = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin-host', 'register.js');
    const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --import ${pathToImport(register)}`.trim();
    return new Promise((resolve) => {
        const child = spawn(bin, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, NODE_OPTIONS: nodeOptions } });
        child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
        child.on('error', (err) => {
            console.error(`[lunx] could not start ${tool}: ${err.message}`);
            resolve(1);
        });
    });
}

function findBin(tool: string, cwd: string): string | null {
    for (let dir = cwd; ; dir = path.dirname(dir)) {
        for (const name of process.platform === 'win32' ? [`${tool}.cmd`, tool] : [tool]) {
            const file = path.join(dir, 'node_modules', '.bin', name);
            if (fs.existsSync(file)) return file;
        }
        if (path.dirname(dir) === dir) return null;
    }
}

/** `--import` takes a URL or a path; a URL survives spaces and Windows drive letters. */
function pathToImport(file: string): string {
    return new URL(`file://${file.split(path.sep).join('/').replace(/^(?!\/)/, '/')}`).href;
}
