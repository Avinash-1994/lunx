/**
 * Lower-level engine pieces the Vite-compatible host (src/vite-host) builds
 * on: a module resolver, the SSR module transform and a MagicString. Like the
 * rest of src/engines, this is the only place that knows they come from
 * Rolldown/Oxc.
 */

const experimental: any = await import('rolldown/experimental');
const rolldown: any = await import('rolldown');

export interface ResolveOptions {
    conditionNames?: string[];
    mainFields?: string[];
    extensions?: string[];
    /** e.g. [['browser']] to honour package.json "browser" maps. */
    aliasFields?: string[][];
    alias?: Record<string, string[]>;
    symlinks?: boolean;
    tsconfig?: { configFile: string; references?: 'auto' };
}

export interface ModuleResolver {
    /** Resolve `request` as imported from a file in `directory`; null when it cannot be found. */
    resolve(directory: string, request: string): string | null;
}

export function createResolver(options: ResolveOptions): ModuleResolver {
    const factory = new experimental.ResolverFactory({
        conditionNames: options.conditionNames,
        mainFields: options.mainFields,
        extensions: options.extensions,
        aliasFields: options.aliasFields,
        alias: options.alias,
        symlinks: options.symlinks ?? true,
        tsconfig: options.tsconfig,
        exportsFields: [['exports']],
        importsFields: [['imports']],
        builtinModules: true,
    });
    return {
        resolve(directory, request) {
            const result = factory.sync(directory, request);
            return result.path ?? null;
        },
    };
}

export interface SsrTransformResult {
    code: string;
    map?: any;
    /** Static import specifiers, as written. */
    deps: string[];
    dynamicDeps: string[];
}

/**
 * ES module → the module-runner form Vite's SSR uses: imports become
 * `await __vite_ssr_import__(spec)`, exports become getters on
 * `__vite_ssr_exports__`, `import.meta` becomes `__vite_ssr_import_meta__`.
 */
export async function ssrTransform(file: string, code: string, sourcemap = false): Promise<SsrTransformResult> {
    const result = await experimental.moduleRunnerTransform(file, code, { sourcemap });
    if (result.errors?.length) {
        const first = result.errors[0];
        const err: any = new Error(`${file}: ${first.message ?? String(first)}`);
        err.id = file;
        throw err;
    }
    return { code: result.code, map: result.map, deps: result.deps, dynamicDeps: result.dynamicDeps };
}

/** MagicString-compatible string editor (overwrite / prepend / appendLeft / toString / generateMap). */
export const MagicString: new (code: string, options?: { filename?: string }) => any = rolldown.RolldownMagicString;

/** Oxc's transform with its own options (Vite's `transformWithOxc`). */
export async function oxcTransform(filename: string, code: string, options: Record<string, any> = {}): Promise<{ code: string; map: any; errors: any[]; warnings: any[] }> {
    const result = await experimental.transform(filename, code, options);
    return { code: result.code, map: result.map ?? null, errors: result.errors ?? [], warnings: result.warnings ?? [] };
}

export { rollupCompatibleBuild } from './rolldown.js';
