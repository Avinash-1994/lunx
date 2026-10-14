/**
 * Import a config file written in TypeScript or ESM (lunx.config.ts,
 * vite.config.ts, postcss.config.ts).
 *
 * A config Node can run as it is (ESM without local imports; TypeScript too
 * when Node strips types) is imported directly, with `stubs` served by a
 * resolve hook: no bundle and no temp file, ~20ms less per command. Anything
 * else, or anything that fails that way, is bundled: local imports inlined,
 * packages kept external.
 */

import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import moduleApi from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface LoadModuleOptions {
    /** Project root: the temp file goes next to its node_modules so bare imports resolve. */
    root: string;
    /** Replace these packages with the given source instead of importing them. */
    stubs?: Record<string, string>;
    /** Evaluate a new instance even if this exact config was imported before (Vite loads its config fresh per build). */
    fresh?: boolean;
    /** Return the module namespace instead of its default export. */
    namespace?: boolean;
}

export async function importBundled(file: string, opts: LoadModuleOptions): Promise<any> {
    const source = await runsNatively(file);
    if (source !== null) {
        try {
            return await importNative(file, source, opts);
        } catch {
            // TypeScript that needs more than type stripping, a missing stub export, …: bundle it.
        }
    }
    return importWithBundle(file, opts);
}

/** Node ≥ 22.15 / 23.5: in-thread resolve hooks, which serve the stubs. */
const registerHooks: ((hooks: object) => unknown) | undefined = (moduleApi as any).registerHooks;

/** The config's source when Node can import it as it is, else null. */
async function runsNatively(file: string): Promise<string | null> {
    if (!registerHooks || process.env.LUNX_CONFIG_BUNDLE === '1') return null;
    const ext = path.extname(file);
    if (!['.mjs', '.js', '.mts', '.ts'].includes(ext)) return null;
    if ((ext === '.mts' || ext === '.ts') && !(process as any).features?.typescript) return null;
    // A typeless package makes Node re-parse ESM and print a warning about it.
    if ((ext === '.js' || ext === '.ts') && !(await inModulePackage(path.dirname(file)))) return null;
    let source: string;
    try {
        source = await fs.readFile(file, 'utf8');
    } catch {
        return null;
    }
    // The bundle defines these for a config; run as it is, it would not have them.
    if (/\b(__dirname|__filename|require)\b/.test(source)) return null;
    // Local imports get inlined with the same definitions: bundle those configs.
    if (/(?:\bfrom|\bimport)\s*\(?\s*['"](?:\.{1,2}\/|\/)/.test(source)) return null;
    return source;
}

async function inModulePackage(dir: string): Promise<boolean> {
    for (;;) {
        try {
            return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).type === 'module';
        } catch (err: any) {
            if (err?.code !== 'ENOENT') return false;
        }
        const parent = path.dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
}

/** Stubs for the configs being imported right now, by module URL. */
const stubbedImports = new Map<string, Record<string, string>>();
/** The resolve hook, installed only while a config with stubs is importing: every import in the process goes through it. */
let hooks: { deregister(): void } | null = null;

async function importNative(file: string, source: string, opts: LoadModuleOptions): Promise<any> {
    // Node names a module by its real path (macOS' /var is /private/var), from the JS realpathSync, which keeps
    // Windows 8.3 short names: the hook sees that URL as the parent.
    // Keyed by content, like the bundle's temp file: an edited config (dev server reload) is a new module.
    let url = `${pathToFileURL(realpathSync(file)).href}?v=${crypto.createHash('sha1').update(source).digest('hex').slice(0, 8)}`;
    if (opts.fresh) url += `&t=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const stubs = opts.stubs ?? {};
    const stubbed = Object.keys(stubs).length > 0;
    if (stubbed) {
        stubbedImports.set(url, stubs);
        hooks ??= registerHooks!({
            resolve(specifier: string, context: { parentURL?: string }, next: (s: string, c: unknown) => unknown) {
                const own = context.parentURL ? stubbedImports.get(context.parentURL) : undefined;
                if (own && Object.hasOwn(own, specifier)) {
                    return { url: `data:text/javascript,${encodeURIComponent(own[specifier]!)}`, shortCircuit: true };
                }
                return next(specifier, context);
            },
        }) as { deregister(): void };
    }
    try {
        const mod = await import(url);
        return opts.namespace ? mod : mod.default ?? mod;
    } finally {
        if (stubbed) {
            stubbedImports.delete(url);
            if (!stubbedImports.size) {
                hooks?.deregister();
                hooks = null;
            }
        }
    }
}

async function importWithBundle(file: string, opts: LoadModuleOptions): Promise<any> {
    const { getBundler } = await import('../engines/index.js');
    const stubs = opts.stubs ?? {};
    const STUB = '\0lunx-stub:';
    // As Node names a module natively: by its real path.
    const real = realpathSync(file);
    const dir = path.dirname(real);
    const output = await getBundler().bundle({
        input: file,
        cwd: opts.root,
        platform: 'node',
        quiet: true,
        // Packages stay external: the config runs against the project's own copies.
        external: (id: string) => !(id in stubs) && !id.startsWith(STUB) && !/^[./]/.test(id) && !path.isAbsolute(id),
        // The bundle runs from a temp file; keep the config's own location.
        define: {
            'import.meta.url': JSON.stringify(pathToFileURL(real).href),
            'import.meta.dirname': JSON.stringify(dir),
            'import.meta.filename': JSON.stringify(real),
            __dirname: JSON.stringify(dir),
            __filename: JSON.stringify(real),
        },
        plugins: [{
            name: 'lunx:config-stubs',
            resolveId(id: string) {
                return id in stubs ? STUB + id : null;
            },
            load(id: string) {
                return id.startsWith(STUB) ? { code: stubs[id.slice(STUB.length)]!, moduleType: 'js' } : null;
            },
        }],
    }, { format: 'es', inlineDynamicImports: true });
    const code = (output[0] as { code: string }).code;

    const tmpDir = path.join(opts.root, 'node_modules', '.lunx');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${path.basename(file)}.${crypto.createHash('sha1').update(code).digest('hex').slice(0, 8)}.mjs`);
    await fs.writeFile(tmp, code);
    try {
        const mod = await import(pathToFileURL(tmp).href + (opts.fresh ? `?t=${Date.now()}${Math.random().toString(36).slice(2, 6)}` : ''));
        return opts.namespace ? mod : mod.default ?? mod;
    } finally {
        await fs.rm(tmp, { force: true });
    }
}
