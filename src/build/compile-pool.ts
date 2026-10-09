/**
 * Compiles framework components on worker threads during production builds.
 *
 * Rolldown bundles in Rust across all cores, but framework compilers (Vue,
 * Svelte, Babel-based JSX) run in JavaScript, so on the main thread they
 * compile one file at a time while the other cores wait. And Rolldown only
 * learns about a component once the file importing it is compiled, so even
 * parallel workers would mostly wait on that chain.
 *
 * So the build lists the project's components up front and the pool starts
 * compiling all of them at once (`prefetch`); when Rolldown reaches a file,
 * its output is usually ready. Each worker loads its compiler once (a few
 * hundred ms), so projects with few components stay on the main thread.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** Below this many components to compile, starting workers costs more than it saves. */
export const MIN_POOL_FILES = 100;
/** Above this many, listing and prefetching every component is not worth it. */
const MAX_PREFETCH_FILES = 20_000;
const SKIP_DIRS = new Set(['node_modules', '.git', '.lunx', '.lunx_cache', '.cache', '.next', '.nuxt', '.svelte-kit', '.output', 'coverage', 'dist']);

interface Pending {
    resolve: (code: string) => void;
    reject: (err: Error) => void;
}

interface Slot {
    worker: Worker;
    inFlight: number;
}

export class CompilePool {
    private slots: Slot[] = [];
    private pending = new Map<number, Pending>();
    private prefetched = new Map<string, { code: string; framework: string; result: Promise<string> }>();
    private nextId = 0;
    private broken: Error | null = null;

    private constructor(size: number, workerFile: URL, root: string, warm: string[]) {
        for (let i = 0; i < size; i++) {
            const worker = new Worker(workerFile, { workerData: { root, warm } });
            worker.on('message', (msg: { id: number; code?: string; error?: { message: string; stack?: string } }) => {
                const p = this.pending.get(msg.id);
                if (!p) return;
                this.pending.delete(msg.id);
                if (msg.error) {
                    const err = new Error(msg.error.message);
                    if (msg.error.stack) err.stack = msg.error.stack;
                    p.reject(err);
                } else {
                    p.resolve(msg.code!);
                }
            });
            worker.on('error', (err) => this.fail(err));
            worker.on('exit', (code) => {
                if (code !== 0 && this.slots.length) this.fail(new Error(`compile worker exited with code ${code}`));
            });
            this.slots.push({ worker, inFlight: 0 });
        }
    }

    /**
     * The project's component files, when a pool may be used at all: null when
     * `LUNX_COMPILE_WORKERS=0`, on one core, when there are too many to list, or
     * when running from TypeScript sources (tests), where the compiled worker
     * does not exist.
     */
    static candidates(root: string, extensions: RegExp, outDir?: string): string[] | null {
        if (process.env.LUNX_COMPILE_WORKERS === '0' || poolSize() < 1) return null;
        if (!fs.existsSync(new URL('./compile-worker.js', import.meta.url))) return null;
        return listFiles(root, extensions, outDir, MAX_PREFETCH_FILES);
    }

    /** Start the workers; each loads the compilers in `warm` straight away. */
    static start(root: string, warm: string[]): CompilePool {
        return new CompilePool(poolSize(), new URL('./compile-worker.js', import.meta.url), root, warm);
    }

    /** True once a worker has crashed: callers compile on the main thread instead. */
    get failed(): boolean {
        return this.broken !== null;
    }

    /** Start compiling a file before Rolldown asks for it. */
    prefetch(file: string, code: string, framework: string): void {
        const result = this.post(file, code, framework);
        result.catch(() => {}); // surfaced, if ever needed, by compile()
        this.prefetched.set(file, { code, framework, result });
    }

    compile(file: string, code: string, framework: string): Promise<string> {
        const hit = this.prefetched.get(file);
        if (hit) {
            this.prefetched.delete(file);
            if (hit.code === code && hit.framework === framework) return hit.result;
        }
        return this.post(file, code, framework);
    }

    async close(): Promise<void> {
        await Promise.all(this.slots.map((s) => s.worker.terminate()));
        this.slots = [];
    }

    private post(file: string, code: string, framework: string): Promise<string> {
        if (this.broken) return Promise.reject(this.broken);
        const slot = this.slots.reduce((a, b) => (b.inFlight < a.inFlight ? b : a));
        const id = this.nextId++;
        slot.inFlight++;
        return new Promise<string>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (c) => { slot.inFlight--; resolve(c); },
                reject: (e) => { slot.inFlight--; reject(e); },
            });
            slot.worker.postMessage({ id, file, code, framework });
        });
    }

    private fail(err: Error): void {
        this.broken = err;
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
    }
}

/** `LUNX_COMPILE_WORKERS=n` sets the size; by default one worker per core but one (Rolldown's), at most 8. */
function poolSize(): number {
    const env = Number(process.env.LUNX_COMPILE_WORKERS);
    if (env > 0) return env;
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return cores > 1 ? Math.min(cores - 1, 8) : 0;
}

/** Files under `root` matching `extensions`; null when there are more than `limit`. */
function listFiles(root: string, extensions: RegExp, outDir: string | undefined, limit: number): string[] | null {
    const skip = outDir ? path.resolve(root, outDir) : null;
    const files: string[] = [];
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
                if (!SKIP_DIRS.has(e.name) && full !== skip && !visit(full)) return false;
            } else if (extensions.test(e.name)) {
                if (files.length >= limit) return false;
                files.push(full);
            }
        }
        return true;
    };
    return visit(root) ? files : null;
}
