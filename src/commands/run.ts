/**
 * `lunx run <script>`: a package.json script across a monorepo's workspaces,
 * dependencies first, independent packages in parallel, with a local cache
 * (as Turborepo and Vite+'s `vp run`):
 *
 *   lunx run build                     every workspace that has a "build" script
 *   lunx run test --filter @acme/ui    one package and the packages it depends on
 *   lunx run build --concurrency 2 --no-cache
 *
 * A task's key is its command, the content of its package's files (not
 * node_modules or its outputs), the keys of the workspace packages it
 * depends on, the lockfile and the build env vars. On a hit its outputs
 * (`"lunx": { "outputs": ["dist"] }` in its package.json; default `dist`)
 * are restored and its log replayed instead of running it.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Workspace {
    name: string;
    dir: string;
    scripts: Record<string, string>;
    deps: string[];
    outputs: string[];
}

const SKIP = new Set(['node_modules', '.git', '.lunx', '.turbo', '.cache', 'coverage']);
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

const readJson = (file: string): any => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};

/** Workspace globs from package.json `workspaces` or pnpm-workspace.yaml `packages`. */
function workspaceGlobs(root: string): string[] {
    const pkg = readJson(path.join(root, 'package.json'));
    const fromPkg = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
    if (Array.isArray(fromPkg)) return fromPkg;
    try {
        const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
        const block = /^packages:\s*\n((?:\s+-.*\n?)+)/m.exec(yaml);
        return block ? [...block[1]!.matchAll(/-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1]!) : [];
    } catch {
        return [];
    }
}

/** Directories matching a workspace glob: `pkgs/*`, `pkgs/**`, or a plain path (negations dropped). */
function expand(root: string, pattern: string): string[] {
    if (pattern.startsWith('!')) return [];
    const parts = pattern.replace(/\/+$/, '').split('/');
    let dirs = [root];
    for (const part of parts) {
        const next: string[] = [];
        for (const dir of dirs) {
            if (part === '**') {
                const stack = [dir];
                while (stack.length) {
                    const d = stack.pop()!;
                    next.push(d);
                    for (const e of safeDir(d)) if (e.isDirectory() && !SKIP.has(e.name)) stack.push(path.join(d, e.name));
                }
            } else if (part.includes('*')) {
                const re = new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
                for (const e of safeDir(dir)) if (e.isDirectory() && !SKIP.has(e.name) && re.test(e.name)) next.push(path.join(dir, e.name));
            } else next.push(path.join(dir, part));
        }
        dirs = next;
    }
    return dirs.filter((d) => fs.existsSync(path.join(d, 'package.json')));
}

const safeDir = (dir: string): fs.Dirent[] => {
    try {
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
};

export function findWorkspaces(root: string): Workspace[] {
    const dirs = [...new Set(workspaceGlobs(root).flatMap((g) => expand(root, g)))];
    const all = dirs.map((dir) => ({ dir, pkg: readJson(path.join(dir, 'package.json')) ?? {} }));
    const names = new Set(all.map((w) => w.pkg.name).filter(Boolean));
    return all
        .filter((w) => w.pkg.name)
        .map(({ dir, pkg }) => ({
            name: pkg.name,
            dir,
            scripts: pkg.scripts ?? {},
            deps: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }).filter((d) => names.has(d) && d !== pkg.name),
            outputs: Array.isArray(pkg.lunx?.outputs) ? pkg.lunx.outputs : ['dist'],
        }));
}

/** The packages a run covers: `filter` and what it depends on, or every package. Throws on a cycle. */
export function plan(workspaces: Workspace[], filter?: string[]): Workspace[][] {
    const byName = new Map(workspaces.map((w) => [w.name, w]));
    let chosen = workspaces;
    if (filter?.length) {
        const re = filter.map((f) => new RegExp(`^${f.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
        const wanted = new Set<string>();
        const add = (name: string) => {
            if (wanted.has(name)) return;
            wanted.add(name);
            for (const d of byName.get(name)?.deps ?? []) add(d);
        };
        for (const w of workspaces) if (re.some((r) => r.test(w.name) || r.test(path.basename(w.dir)))) add(w.name);
        chosen = workspaces.filter((w) => wanted.has(w.name));
    }
    // Levels: a package runs once every workspace package it depends on has.
    const levels: Workspace[][] = [];
    const done = new Set<string>();
    let rest = chosen;
    while (rest.length) {
        const ready = rest.filter((w) => w.deps.every((d) => done.has(d) || !chosen.some((c) => c.name === d)));
        if (!ready.length) throw new Error(`dependency cycle between: ${rest.map((w) => w.name).join(', ')}`);
        levels.push(ready);
        for (const w of ready) done.add(w.name);
        rest = rest.filter((w) => !ready.includes(w));
    }
    return levels;
}

function hashFiles(dir: string, outputs: string[], hash: crypto.Hash): void {
    const skip = new Set(outputs.map((o) => path.join(dir, o)));
    const files: string[] = [];
    const stack = [dir];
    while (stack.length) {
        const d = stack.pop()!;
        for (const e of safeDir(d)) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) {
                if (!SKIP.has(e.name) && !skip.has(full)) stack.push(full);
            } else if (e.isFile()) files.push(full);
        }
    }
    for (const file of files.sort()) {
        hash.update(path.relative(dir, file).split(path.sep).join('/')).update('\0');
        hash.update(fs.readFileSync(file)).update('\0');
    }
}

export function taskKey(root: string, w: Workspace, script: string, depKeys: string[]): string {
    const hash = crypto.createHash('sha256');
    hash.update(`${script}\0${w.scripts[script]}\0${depKeys.join(',')}\0`);
    for (const lock of LOCKFILES) {
        const file = path.join(root, lock);
        if (fs.existsSync(file)) hash.update(lock).update(fs.readFileSync(file));
    }
    const env = Object.entries(process.env).filter(([k]) => /^(NODE_ENV|CI|LUNX_|VITE_|PUBLIC_|NEXT_PUBLIC_)/.test(k)).sort(([a], [b]) => (a < b ? -1 : 1));
    hash.update(JSON.stringify(env));
    hashFiles(w.dir, w.outputs, hash);
    return hash.digest('hex');
}

function copyDir(from: string, to: string): void {
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
}

function exec(command: string, cwd: string, root: string, onOutput: (chunk: string) => void): Promise<number> {
    const bins = [path.join(cwd, 'node_modules', '.bin'), path.join(root, 'node_modules', '.bin')];
    const PATH = [...bins, process.env.PATH ?? ''].join(path.delimiter);
    return new Promise((resolve) => {
        const child = spawn(command, { cwd, shell: true, env: { ...process.env, PATH, FORCE_COLOR: process.stdout.isTTY ? '1' : process.env.FORCE_COLOR } });
        child.stdout.on('data', (d) => onOutput(String(d)));
        child.stderr.on('data', (d) => onOutput(String(d)));
        child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
        child.on('error', () => resolve(127));
    });
}

export interface RunOptions {
    filter?: string[];
    concurrency?: number;
    cache?: boolean;
    log?: (line: string) => void;
}

/** Runs `script` across the workspaces; resolves to the exit code (the first failure's). */
export async function runTask(root: string, script: string, options: RunOptions = {}): Promise<number> {
    const log = options.log ?? ((line: string) => process.stdout.write(line));
    const workspaces = findWorkspaces(root);
    if (!workspaces.length) {
        log(`[lunx] no workspaces found in ${root} (package.json "workspaces" or pnpm-workspace.yaml)\n`);
        return 1;
    }
    let levels: Workspace[][];
    try {
        levels = plan(workspaces, options.filter);
    } catch (err) {
        log(`[lunx] ${(err as Error).message}\n`);
        return 1;
    }
    const concurrency = Math.max(1, options.concurrency ?? Math.max(1, os.availableParallelism?.() ?? os.cpus().length));
    const keys = new Map<string, string>();
    const started = Date.now();
    let ran = 0;
    let hits = 0;
    let failed = 0;
    for (const level of levels) {
        const queue = level.filter((w) => w.scripts[script]);
        for (const w of level) if (!w.scripts[script]) keys.set(w.name, taskKey(root, w, script, w.deps.map((d) => keys.get(d) ?? '')));
        const worker = async () => {
            for (let w = queue.shift(); w; w = queue.shift()) {
                const key = taskKey(root, w, script, w.deps.map((d) => keys.get(d) ?? ''));
                keys.set(w.name, key);
                const prefix = `${w.name}:${script}`;
                const entry = path.join(root, '.lunx', 'tasks', w.name.replace(/[\\/]/g, '__'), script, key.slice(0, 24));
                if (options.cache !== false && fs.existsSync(path.join(entry, 'log.txt'))) {
                    for (const out of w.outputs) {
                        const saved = path.join(entry, 'outputs', out);
                        if (!fs.existsSync(saved)) continue;
                        fs.rmSync(path.join(w.dir, out), { recursive: true, force: true });
                        copyDir(saved, path.join(w.dir, out));
                    }
                    const replay = fs.readFileSync(path.join(entry, 'log.txt'), 'utf8').replace(/\n$/, '');
                    log(`${prefix} cache hit, replaying output\n${replay ? replay.replace(/^/gm, `${prefix}: `) + '\n' : ''}`);
                    hits++;
                    continue;
                }
                log(`${prefix} $ ${w.scripts[script]}\n`);
                let output = '';
                const code = await exec(w.scripts[script]!, w.dir, root, (chunk) => {
                    output += chunk;
                    log(chunk.replace(/^(?=.)/gm, `${prefix}: `));
                });
                ran++;
                if (code !== 0) {
                    log(`${prefix} failed (exit ${code})\n`);
                    failed++;
                    queue.length = 0;
                    continue;
                }
                if (options.cache !== false) {
                    fs.rmSync(entry, { recursive: true, force: true });
                    for (const out of w.outputs) {
                        const produced = path.join(w.dir, out);
                        if (fs.existsSync(produced)) copyDir(produced, path.join(entry, 'outputs', out));
                    }
                    fs.mkdirSync(entry, { recursive: true });
                    fs.writeFileSync(path.join(entry, 'log.txt'), output);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
        if (failed) break;
    }
    const total = ran + hits;
    log(`\n  ${failed ? '✗' : '✓'} ${script}: ${total} task${total === 1 ? '' : 's'} (${hits} cached, ${ran} ran${failed ? `, ${failed} failed` : ''}) in ${Date.now() - started} ms\n`);
    return failed ? 1 : 0;
}
