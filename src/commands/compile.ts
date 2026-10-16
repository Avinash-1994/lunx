/**
 * `lunx compile <entry>`: a program and its dependencies as one executable
 * that runs without Node or node_modules installed (as `bun build --compile`
 * and `deno compile`), on Node's single executable applications.
 *
 *   lunx compile src/server.ts                 → ./server (server.exe on Windows)
 *   lunx compile src/cli.ts --outfile bin/tool
 *
 * Rolldown bundles the entry (TypeScript included) into one CommonJS file;
 * Node turns it into a blob (`--experimental-sea-config`, or `--build-sea`
 * where Node has it), which postject (the project's, else fetched through
 * npx) injects into a copy of this Node binary. macOS binaries are re-signed
 * ad hoc. The executable runs on this platform and architecture.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const POSTJECT = 'postject@1.0.0-alpha.6';

export interface CompileOptions {
    outfile?: string;
    /** Values for `process.env.X` in the bundle (default NODE_ENV=production). */
    define?: Record<string, string>;
    log?: (line: string) => void;
}

const run = (cmd: string, args: string[], cwd: string) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' && !path.isAbsolute(cmd) });
    if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed:\n${(r.stdout ?? '') + (r.stderr ?? '') || r.error?.message}`);
    return r.stdout;
};

export async function compile(entry: string, cwd = process.cwd(), options: CompileOptions = {}): Promise<string> {
    const log = options.log ?? ((line: string) => console.log(line));
    const input = path.resolve(cwd, entry);
    if (!fs.existsSync(input)) throw new Error(`${entry} not found`);
    const exe = process.platform === 'win32' ? '.exe' : '';
    const outfile = path.resolve(cwd, options.outfile ?? path.basename(input).replace(/\.[^.]+$/, '') + exe);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-compile-'));
    try {
        // 1. One CommonJS file: Node's single-executable main script runs as CommonJS.
        const { rolldown } = await import('rolldown');
        const bundle = await rolldown({
            input,
            cwd,
            platform: 'node',
            logLevel: 'silent',
            transform: { define: { 'process.env.NODE_ENV': '"production"', ...options.define } },
        } as any);
        const main = path.join(work, 'main.cjs');
        try {
            await bundle.write({ file: main, format: 'cjs', codeSplitting: false, minify: true } as any);
        } finally {
            await bundle.close();
        }

        // 2. The blob.
        const blob = path.join(work, 'sea.blob');
        const config = path.join(work, 'sea-config.json');
        fs.writeFileSync(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }));
        const buildSea = spawnSync(process.execPath, ['--help'], { encoding: 'utf8' }).stdout.includes('--build-sea');
        if (buildSea) {
            fs.writeFileSync(config, JSON.stringify({ main, output: outfile, disableExperimentalSEAWarning: true }));
            run(process.execPath, ['--build-sea', config], work);
            log(`  ✓ ${path.relative(cwd, outfile)} (${(fs.statSync(outfile).size / 1e6).toFixed(1)} MB)`);
            return outfile;
        }
        run(process.execPath, ['--experimental-sea-config', config], work);

        // 3. A copy of this Node with the blob injected.
        fs.mkdirSync(path.dirname(outfile), { recursive: true });
        fs.copyFileSync(process.execPath, outfile);
        fs.chmodSync(outfile, 0o755);
        if (process.platform === 'darwin') run('codesign', ['--remove-signature', outfile], cwd);
        const local = findBin('postject', cwd);
        const injectArgs = [outfile, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE, ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])];
        if (local) run(local, injectArgs, cwd);
        else run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', POSTJECT, ...injectArgs], cwd);
        if (process.platform === 'darwin') run('codesign', ['--sign', '-', outfile], cwd);
        log(`  ✓ ${path.relative(cwd, outfile)} (${(fs.statSync(outfile).size / 1e6).toFixed(1)} MB)`);
        return outfile;
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
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
