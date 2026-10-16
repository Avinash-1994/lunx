/**
 * `lunx lint` and `lunx fmt`: Oxlint and Oxfmt (Rust, from the Oxc project
 * whose parser and minifier lunx already builds with), as Vite+'s `vp lint`
 * and `vp fmt`.
 *
 *   lunx lint [paths…] [--fix]        oxlint (eslint-compatible rules)
 *   lunx fmt [paths…] [--check]       oxfmt (Prettier-compatible output)
 *
 * The project's own oxlint / oxfmt run when installed; otherwise the pinned
 * version below is fetched once through npx. Arguments pass through.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TOOLS = {
    lint: { bin: 'oxlint', version: '1.88.0' },
    fmt: { bin: 'oxfmt', version: '0.73.0' },
} as const;

export async function runOxc(command: keyof typeof TOOLS, args: string[], cwd = process.cwd()): Promise<number> {
    const { bin, version } = TOOLS[command];
    const local = findBin(bin, cwd);
    const [cmd, cmdArgs] = local ? [local, args] : [process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', `${bin}@${version}`, ...args]];
    if (!local) console.log(`[lunx] ${bin} is not installed here; running ${bin}@${version} through npx (npm i -D ${bin} to pin it).`);
    return new Promise((resolve) => {
        const child = spawn(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
        child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
        child.on('error', (err) => {
            console.error(`[lunx] could not start ${bin}: ${err.message}`);
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
