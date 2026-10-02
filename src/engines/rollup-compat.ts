/**
 * Rollup's JavaScript API (`rollup()`, `watch()`) on the engine, for tools
 * that drive Rollup themselves (Nitro packages Nuxt / SolidStart servers this
 * way). The Rollup plugins whose job the engine does natively — node-resolve,
 * commonjs, json, terser — reach this as markers carrying their options (see
 * src/plugin-host/shims/rollup-plugins.ts) and become engine options; no
 * Rollup code runs.
 */

const engine: any = await import('rolldown');

export const VERSION = '4.40.0';

const INPUT_KEYS = new Set([
    'input', 'plugins', 'external', 'treeshake', 'preserveEntrySignatures', 'shimMissingExports', 'logLevel', 'onLog', 'onwarn',
    'moduleTypes', 'context', 'cwd', 'platform', 'resolve', 'transform', 'jsx', 'watch', 'checks', 'experimental', 'keepNames',
    'makeAbsoluteExternalsRelative', 'tsconfig', 'inject', 'define', 'optimization', 'profilerNames',
]);

const OUTPUT_DROP = new Set([
    'hoistTransitiveImports', 'experimentalMinChunkSize', 'generatedCode', 'interop', 'compact', 'dynamicImportInCjs', 'freeze',
    'indent', 'noConflict', 'validate', 'experimentalDeepDynamicChunkOptimization', 'inlineDynamicImports', 'manualChunks',
    'preserveModulesRoot', 'externalImportAttributes', 'externalLiveBindings', 'importAttributesKey', 'reexportProtoFromExternal', 'sourcemapFileNames',
]);

export interface PluginMarker {
    lunxNative: 'node-resolve' | 'commonjs' | 'json' | 'terser';
    options: Record<string, any>;
}

function flatten(list: unknown): any[] {
    const out: any[] = [];
    for (const item of Array.isArray(list) ? list : [list]) {
        if (Array.isArray(item)) out.push(...flatten(item));
        else if (item) out.push(item);
    }
    return out;
}

function adaptInput(options: Record<string, any>): Record<string, any> {
    const input: Record<string, any> = {};
    for (const [k, v] of Object.entries(options)) if (INPUT_KEYS.has(k)) input[k] = v;
    const plugins: any[] = [];
    for (const plugin of flatten(options.plugins)) {
        const marker = plugin?.lunxNative as PluginMarker['lunxNative'] | undefined;
        if (!marker) {
            plugins.push(plugin);
            continue;
        }
        const opts = plugin.options ?? {};
        if (marker === 'node-resolve') {
            input.resolve = {
                ...input.resolve,
                ...(opts.exportConditions ? { conditionNames: [...new Set([...opts.exportConditions, 'default'])] } : {}),
                ...(opts.mainFields ? { mainFields: opts.mainFields } : {}),
                ...(opts.extensions ? { extensions: opts.extensions } : {}),
                ...(opts.browser ? { aliasFields: [['browser']] } : {}),
            };
            if (opts.preferBuiltins !== false && !input.platform) input.platform = 'node';
        } else if (marker === 'terser') {
            input.__minify = true;
            if (opts.mangle?.keep_fnames || opts.mangle?.keep_classnames || opts.keep_fnames || opts.keep_classnames) input.keepNames = true;
        }
        // commonjs and json: the engine handles both natively.
    }
    input.plugins = plugins;
    if (options.onwarn && !options.onLog) {
        const onwarn = options.onwarn;
        input.onLog = (level: string, log: any, handler: (level: any, log: any) => void) => {
            if (level === 'warn') onwarn(log, (w: any) => handler('warn', typeof w === 'string' ? { message: w } : w));
            else handler(level, log);
        };
        delete input.onwarn;
    }
    return input;
}

function adaptOutput(options: Record<string, any> = {}, minify: boolean): Record<string, any> {
    const output: Record<string, any> = {};
    for (const [k, v] of Object.entries(options)) if (!OUTPUT_DROP.has(k) && v !== undefined) output[k] = v;
    if (options.inlineDynamicImports) output.codeSplitting = false;
    if (output.format === 'esm' || output.format === 'module') output.format = 'es';
    if (output.format === 'commonjs') output.format = 'cjs';
    if (minify && output.minify === undefined) output.minify = true;
    return output;
}

/** `rollup(options)`: a bundle with generate / write / close. */
export async function rollup(options: Record<string, any>): Promise<any> {
    const input = adaptInput(options);
    const minify = !!input.__minify;
    delete input.__minify;
    const bundle: any = await engine.rolldown(input as any);
    return {
        cache: undefined,
        watchFiles: bundle.watchFiles ?? [],
        get closed() {
            return !!bundle.closed;
        },
        generate: (out: Record<string, any>) => bundle.generate(adaptOutput(out, minify)),
        write: (out: Record<string, any>) => bundle.write(adaptOutput(out, minify)),
        close: () => bundle.close(),
        [Symbol.asyncDispose]: () => bundle.close(),
    };
}

/** `watch(options)`: the engine's watcher, which emits Rollup's event codes. */
export function watch(options: Record<string, any> | Record<string, any>[]): any {
    const configs = (Array.isArray(options) ? options : [options]).map((o) => {
        const input = adaptInput(o);
        const minify = !!input.__minify;
        delete input.__minify;
        const outputs = (Array.isArray(o.output) ? o.output : [o.output ?? {}]).map((out: any) => adaptOutput(out, minify));
        return { ...input, output: outputs.length === 1 ? outputs[0] : outputs };
    });
    return engine.watch(configs as any);
}
