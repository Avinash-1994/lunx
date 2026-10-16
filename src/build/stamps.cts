/**
 * File stamps for the build cache (src/build/build-cache.ts), in CommonJS so
 * the CLI's fast path (src/cli-fast.cts) can check a build before Node's ES
 * module loader, crypto or the rest of lunx is loaded: an up-to-date
 * `lunx build` then costs a Node start and a directory walk.
 *
 * A build's output is kept as hard links in `.lunx/build-output/<id>/`, so an
 * unchanged project whose output directory was deleted (a clean checkout of
 * `dist/`, a CI step that removes it) gets it back without rebuilding. The
 * links share the output files' inodes: a file changed in place no longer
 * matches its recorded stamp, and is never restored.
 */
import fs from 'node:fs';
import path from 'node:path';

export type Stamp = [number, number]; // mtimeMs, size

export const SKIP_DIRS = new Set(['node_modules', '.git', '.lunx', '.lunx_cache', '.cache', '.turbo', '.next', '.nuxt', '.svelte-kit', '.output', 'coverage']);
const MAX_FILES = 25_000;
const INSTALL_MARKERS = ['node_modules/.package-lock.json', 'node_modules/.pnpm/lock.yaml', 'node_modules/.yarn-state.yml', 'node_modules/.modules.yaml'];

export interface Entry {
    key: string;
    inputs: Record<string, Stamp>;
    outputs: Record<string, Stamp>;
    outDir: string;
    builtAt: number;
}

export function stamp(file: string): Stamp | null {
    const s = fs.statSync(file, { throwIfNoEntry: false });
    return s ? [Math.round(s.mtimeMs), s.size] : null;
}

/** Every file under `dir` (relative paths), skipping dependency, VCS, cache and output dirs. */
export function walk(root: string, skip: Set<string>): Record<string, Stamp> | null {
    const out: Record<string, Stamp> = {};
    let count = 0;
    const visit = (dir: string): boolean => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return true;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name) || skip.has(full)) continue;
                if (!visit(full)) return false;
            } else if (e.isFile()) {
                if (++count > MAX_FILES) return false;
                const s = stamp(full);
                if (s) out[path.relative(root, full)] = s;
            }
        }
        return true;
    };
    return visit(root) ? out : null;
}

/** The project's inputs: every file outside `outDir` and the dependency dirs, plus the install markers. */
export function inputsOf(root: string, outDir: string): Record<string, Stamp> | null {
    const inputs = walk(root, new Set([outDir]));
    if (!inputs) return null;
    addInstallMarkers(root, inputs);
    return inputs;
}

export function addInstallMarkers(root: string, inputs: Record<string, Stamp>): void {
    for (const marker of INSTALL_MARKERS) {
        const s = stamp(path.join(root, marker));
        if (s) inputs[marker] = s;
    }
}

export function same(a: Record<string, Stamp>, b: Record<string, Stamp>): boolean {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const k of keys) {
        const x = a[k]!;
        const y = b[k];
        if (!y || x[0] !== y[0] || x[1] !== y[1]) return false;
    }
    return true;
}

/** The env vars a build depends on, in a stable order. */
export function buildEnv(): [string, string | undefined][] {
    return Object.entries(process.env)
        .filter(([k]) => /^(NODE_ENV|LUNX_|VITE_|PUBLIC_|REACT_APP_)/.test(k) && k !== 'LUNX_TIMINGS' && k !== 'LUNX_FAST_PATH')
        // Code-unit order: localeCompare would load ICU's collator, ~13ms on the first call.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const snapshotDir = (cacheFile: string) => path.join(path.dirname(path.dirname(cacheFile)), 'build-output', path.basename(cacheFile, '.json'));

/** Keep the build's output (hard links; copies across devices) beside its cache entry. */
export function snapshotOutput(cacheFile: string, entry: Entry): void {
    const dir = snapshotDir(cacheFile);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const rel of Object.keys(entry.outputs)) {
        const to = path.join(dir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        linkOrCopy(path.join(entry.outDir, rel), to);
    }
}

/**
 * Put the recorded output files back from the snapshot, if every snapshot
 * file is still the one recorded (other files in the output directory are
 * left alone). Returns the output's stamps after restoring, or null.
 */
export function restoreOutput(cacheFile: string, entry: Entry): Record<string, Stamp> | null {
    const dir = snapshotDir(cacheFile);
    const files = Object.keys(entry.outputs);
    if (!files.length) return null;
    const matches = (file: string, rel: string) => {
        const s = stamp(file);
        return !!s && s[0] === entry.outputs[rel]![0] && s[1] === entry.outputs[rel]![1];
    };
    if (!files.every((rel) => matches(path.join(dir, rel), rel))) return null;
    for (const rel of files) {
        const to = path.join(entry.outDir, rel);
        if (matches(to, rel)) continue;
        fs.rmSync(to, { force: true });
        fs.mkdirSync(path.dirname(to), { recursive: true });
        linkOrCopy(path.join(dir, rel), to);
    }
    return walk(entry.outDir, new Set());
}

function linkOrCopy(from: string, to: string): void {
    try {
        fs.linkSync(from, to);
    } catch {
        fs.copyFileSync(from, to);
        const s = fs.statSync(from);
        fs.utimesSync(to, s.atime, s.mtime);
    }
}

/**
 * Is the recorded output in place, restoring it from its snapshot if it was
 * removed or changed? Updates `entry.outputs` when the restored stamps differ.
 */
export function outputCurrent(cacheFile: string, entry: Entry): 'current' | 'restored' | false {
    if (!Object.keys(entry.outputs).length) return false;
    if (same(entry.outputs, walk(entry.outDir, new Set()) ?? {})) return 'current';
    const restored = restoreOutput(cacheFile, entry);
    if (!restored) return false;
    if (!same(entry.outputs, restored)) {
        // Copies (another device) or other files beside the output: these stamps stand from now on.
        entry.outputs = restored;
        fs.writeFileSync(cacheFile, JSON.stringify(entry));
    }
    return 'restored';
}

/**
 * The CLI invocation a fast-path record matches: lunx's version, the
 * arguments after `build` and the build's env vars.
 */
export function invocation(version: string, args: string[]): string {
    return JSON.stringify([version, args, buildEnv()]);
}

export const lastBuildFile = (root: string) => path.join(root, '.lunx', 'build-cache', 'last.json');
