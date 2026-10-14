/**
 * Electron apps, with nothing to configure: the renderer is a regular lunx app
 * (built with base `./`, since Electron loads it from disk), and lunx builds
 * the main process and preload with Rolldown into `dist-electron/`. In dev it
 * starts Electron on the dev server, restarts it when the main process changes
 * and reloads the window when the preload does. `lunx preview` runs the build.
 *
 * Entries: `electron/main.*` and `electron/preload.*`, or `electron: { main,
 * preload }` in lunx.config. A project using vite-plugin-electron keeps it.
 */

import fs from 'fs';
import path from 'path';
import { builtinModules, createRequire } from 'module';
import type { ChildProcess } from 'child_process';

export interface ElectronOptions {
    /** Main-process entry. Default: `electron/main.{ts,js,…}`. */
    main?: string;
    /** Preload entry, or `false` for none. Default: `electron/preload.{ts,js,…}` if it exists. */
    preload?: string | false;
    /** Where the main process and preload are written. Default: `dist-electron`. */
    outDir?: string;
}

export interface ElectronApp {
    root: string;
    main: string;
    preload?: string;
    outDir: string;
    /** `"type": "module"`: the main process is written as ESM. */
    esm: boolean;
    /** Installed at runtime (packaged with the app), so not bundled into the main process. */
    dependencies: string[];
    /** package.json `main`, which Electron starts from. */
    packageMain?: string;
}

const EXTENSIONS = ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'];
const MAIN_FILE = 'main.js';
const PRELOAD_FILE = 'preload.cjs';

function find(root: string, ...bases: string[]): string | undefined {
    for (const base of bases) {
        for (const ext of EXTENSIONS) {
            const file = path.join(root, `${base}.${ext}`);
            if (fs.existsSync(file)) return file;
        }
    }
    return undefined;
}

/** vite-plugin-electron builds and starts Electron itself. */
function hasElectronPlugin(config: any): boolean {
    const plugins = [...(config.plugins ?? []), ...(config.__vitePlugins ?? [])].flat(Infinity);
    return plugins.some((p: any) => typeof p?.name === 'string' && p.name.startsWith('vite-plugin-electron'));
}

/** The Electron app lunx builds, or null when the project isn't one (or vite-plugin-electron handles it). */
export function resolveElectron(root: string, config: any = {}): ElectronApp | null {
    const options: ElectronOptions | false | undefined = config.electron;
    if (options === false) return null;
    let pkg: any;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch {
        return null;
    }
    if (!pkg.dependencies?.electron && !pkg.devDependencies?.electron) return null;
    if (hasElectronPlugin(config)) return null;
    const main = options?.main ? path.resolve(root, options.main) : find(root, 'electron/main', 'electron/main/index');
    if (!main) return null;
    const preload = options?.preload === false ? undefined
        : options?.preload ? path.resolve(root, options.preload)
        : find(root, 'electron/preload', 'electron/preload/index');
    return {
        root,
        main,
        preload,
        outDir: path.resolve(root, options?.outDir ?? 'dist-electron'),
        esm: pkg.type === 'module',
        dependencies: Object.keys(pkg.dependencies ?? {}).filter((d) => d !== 'electron'),
        packageMain: pkg.main,
    };
}

const BUILTINS = new Set(builtinModules);
const isBuiltin = (id: string) => id.startsWith('node:') || BUILTINS.has(id) || BUILTINS.has(id.split('/')[0]!);
const under = (names: string[]) => (id: string) => names.some((n) => id === n || id.startsWith(n + '/'));

/** Rolldown options for the main process and the preload. */
function bundles(app: ElectronApp, dev: boolean): Array<{ input: any; output: any; kind: 'main' | 'preload' }> {
    const runtime = under(app.dependencies);
    const common = { platform: 'node' as const, cwd: app.root, logLevel: 'warn' as const };
    const list: Array<{ input: any; output: any; kind: 'main' | 'preload' }> = [{
        kind: 'main',
        input: { ...common, input: { main: app.main }, external: (id: string) => id === 'electron' || id.startsWith('electron/') || isBuiltin(id) || runtime(id) },
        output: { dir: app.outDir, format: app.esm ? 'es' : 'cjs', entryFileNames: MAIN_FILE, chunkFileNames: '[name]-[hash].js', sourcemap: dev },
    }];
    if (app.preload) {
        // Sandboxed preloads (Electron's default) run as one CommonJS file that may require only
        // `electron` and a few built-ins: everything else is bundled in.
        list.push({
            kind: 'preload',
            input: { ...common, input: { preload: app.preload }, external: (id: string) => id === 'electron' || id.startsWith('electron/') || isBuiltin(id) },
            output: { dir: app.outDir, format: 'cjs', entryFileNames: PRELOAD_FILE, codeSplitting: false, sourcemap: dev ? 'inline' : false },
        });
    }
    return list;
}

/** `lunx build`: the main process and preload, written to `dist-electron/`. */
export async function buildElectron(app: ElectronApp): Promise<string[]> {
    const { rolldown } = await import('rolldown');
    fs.rmSync(app.outDir, { recursive: true, force: true });
    const written = await Promise.all(bundles(app, false).map(async ({ input, output }) => {
        const bundle = await rolldown(input);
        try {
            const { output: files } = await bundle.write(output);
            return files.map((f) => path.relative(app.root, path.join(app.outDir, f.fileName)));
        } finally {
            await bundle.close();
        }
    }));
    return written.flat();
}

function electronBinary(root: string): string {
    // The `electron` package exports the path of the binary it downloaded.
    const binary = createRequire(path.join(root, 'package.json'))('electron');
    if (typeof binary !== 'string') throw new Error('the electron package did not give a binary path (is its postinstall blocked?)');
    return binary;
}

/** Electron starts from package.json `main` when it points at the build; otherwise from the built file. */
function startArgs(app: ElectronApp): string[] {
    const built = path.join(app.outDir, MAIN_FILE);
    const fromPackage = app.packageMain && path.resolve(app.root, app.packageMain) === built;
    const args = [fromPackage ? '.' : built];
    // Chromium refuses to run as root with its sandbox (containers, CI).
    if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
    // Extra switches, e.g. `--inspect=5858` to debug the main process.
    args.push(...(process.env.LUNX_ELECTRON_ARGS ?? '').split(/\s+/).filter(Boolean));
    return args;
}

async function spawnElectron(app: ElectronApp, env: Record<string, string>): Promise<ChildProcess> {
    const { spawn } = await import('child_process');
    return spawn(electronBinary(app.root), startArgs(app), { cwd: app.root, stdio: 'inherit', env: { ...process.env, ...env } });
}

/** `lunx preview`: the built app in Electron. */
export async function previewElectron(app: ElectronApp): Promise<number> {
    const built = path.join(app.outDir, MAIN_FILE);
    if (!fs.existsSync(built)) throw new Error(`${path.relative(app.root, built)} not found: run \`lunx build\` first`);
    const child = await spawnElectron(app, {});
    const stop = () => child.kill();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return new Promise((resolve) => child.on('exit', (code) => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve(code ?? 0);
    }));
}

export interface ElectronDev {
    close(): Promise<void>;
}

/**
 * `lunx dev`: watches and builds the main process and preload, then starts
 * Electron with the dev server's URL in `LUNX_DEV_SERVER_URL` (and
 * `VITE_DEV_SERVER_URL`, for code written for vite-plugin-electron).
 * `LUNX_ELECTRON_START=0` builds without starting it; `LUNX_ELECTRON_ARGS`
 * adds switches to Electron's command line.
 */
export async function devElectron(app: ElectronApp, url: string, hooks: { reload(): void; log(message: string): void; error(message: string): void }): Promise<ElectronDev> {
    const { watch } = await import('rolldown');
    const start = process.env.LUNX_ELECTRON_START !== '0';
    const env = { LUNX_DEV_SERVER_URL: url, VITE_DEV_SERVER_URL: url };
    let child: ChildProcess | undefined;
    let restarting = false;
    let closed = false;

    const launch = async () => {
        if (!start || closed) return;
        if (child && child.exitCode === null) {
            restarting = true;
            const exited = new Promise((resolve) => child!.once('exit', resolve));
            child.kill();
            await exited;
            restarting = false;
        }
        const current = await spawnElectron(app, env);
        child = current;
        // Closing the app ends the dev session, as it does with vite-plugin-electron.
        current.once('exit', (code) => {
            if (!restarting && !closed && child === current) process.exit(code ?? 0);
        });
    };
    const stop = () => { if (child && child.exitCode === null) child.kill(); };
    // Stopping lunx stops Electron; its exit then ends the session.
    const onSignal = () => (child && child.exitCode === null ? child.kill() : process.exit(130));
    process.once('exit', stop);
    if (start) {
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
    }

    const list = bundles(app, true);
    const pending = new Set(list.map((b) => b.kind));
    let firstBuild!: () => void;
    const built = new Promise<void>((resolve) => { firstBuild = resolve; });
    const watchers = list.map(({ input, output, kind }) => {
        const watcher = watch({ ...input, output, watch: { exclude: [path.join(app.root, 'node_modules/**')] } });
        watcher.on('event', async (event: any) => {
            if (event.code === 'ERROR') {
                hooks.error(`[electron] ${kind}: ${event.error?.message ?? event.error}`);
                await event.result?.close();
                return;
            }
            if (event.code !== 'BUNDLE_END') return;
            await event.result?.close();
            if (pending.size) {
                pending.delete(kind);
                if (!pending.size) firstBuild();
                return;
            }
            if (kind === 'main') {
                hooks.log(`[electron] main process rebuilt in ${Math.round(event.duration)}ms, restarting`);
                await launch();
            } else {
                hooks.log(`[electron] preload rebuilt in ${Math.round(event.duration)}ms, reloading`);
                hooks.reload();
            }
        });
        return watcher;
    });

    await built;
    hooks.log(`[electron] main process${app.preload ? ' and preload' : ''} built to ${path.relative(app.root, app.outDir)}/`);
    await launch();

    return {
        async close() {
            closed = true;
            process.off('exit', stop);
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
            stop();
            await Promise.all(watchers.map((w) => w.close()));
        },
    };
}
