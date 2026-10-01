/**
 * Import a config file written in TypeScript or ESM (lunx.config.ts,
 * vite.config.ts, postcss.config.ts): bundle its local imports with Rolldown,
 * keep packages external, and import the result.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface LoadModuleOptions {
    /** Project root: the temp file goes next to its node_modules so bare imports resolve. */
    root: string;
    /** Replace these packages with the given source instead of importing them. */
    stubs?: Record<string, string>;
}

export async function importBundled(file: string, opts: LoadModuleOptions): Promise<any> {
    const { rolldown } = await import('rolldown');
    const stubs = opts.stubs ?? {};
    const STUB = '\0lunx-stub:';
    const dir = path.dirname(file);
    const bundle = await rolldown({
        input: file,
        cwd: opts.root,
        platform: 'node',
        logLevel: 'silent',
        // Packages stay external: the config runs against the project's own copies.
        external: (id: string) => !(id in stubs) && !id.startsWith(STUB) && !/^[./]/.test(id) && !path.isAbsolute(id),
        transform: {
            // The bundle runs from a temp file; keep the config's own location.
            define: {
                'import.meta.url': JSON.stringify(pathToFileURL(file).href),
                'import.meta.dirname': JSON.stringify(dir),
                'import.meta.filename': JSON.stringify(file),
                __dirname: JSON.stringify(dir),
                __filename: JSON.stringify(file),
            },
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
    } as any);
    const { output } = await bundle.generate({ format: 'es', inlineDynamicImports: true } as any);
    await bundle.close();
    const code = (output[0] as any).code as string;

    const tmpDir = path.join(opts.root, 'node_modules', '.lunx');
    await fs.mkdir(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${path.basename(file)}.${crypto.createHash('sha1').update(code).digest('hex').slice(0, 8)}.mjs`);
    await fs.writeFile(tmp, code);
    try {
        const mod = await import(pathToFileURL(tmp).href);
        return mod.default ?? mod;
    } finally {
        await fs.rm(tmp, { force: true });
    }
}
