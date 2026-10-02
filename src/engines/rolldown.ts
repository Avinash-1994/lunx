/**
 * The default `Bundler`: Rolldown (Rust). This file is the only place lunx
 * talks to Rolldown's API; everything else uses the contract in ./types.ts.
 */

import type { BundleInput, BundleOutputOptions, Bundler, OutputItem } from './types.js';

export const rolldownBundler: Bundler = {
    name: 'rolldown',

    async available() {
        try {
            await import('rolldown');
            return true;
        } catch {
            return false;
        }
    },

    async bundle(input: BundleInput, output: BundleOutputOptions, write = false): Promise<OutputItem[]> {
        const { rolldown } = await import('rolldown');
        const bundle = await rolldown({
            input: input.input,
            cwd: input.cwd,
            platform: input.platform,
            plugins: input.plugins,
            external: input.external,
            logLevel: input.quiet ? 'silent' : 'warn',
            ...(input.tsconfig ? { tsconfig: input.tsconfig } : {}),
            resolve: {
                ...(input.alias ? { alias: input.alias } : {}),
                ...(input.extensions ? { extensions: input.extensions } : {}),
                ...(input.conditions ? { conditionNames: input.conditions } : {}),
            },
            transform: {
                ...(input.define ? { define: input.define } : {}),
                ...(input.jsx ? { jsx: input.jsx } : {}),
            },
            onLog(level: string, log: any, handler: (level: any, log: any) => void) {
                if (level === 'warn' && input.onWarning?.({ code: log.code, message: log.message }) === false) return;
                handler(level, log);
            },
        } as any);

        const outputOptions: any = {
            dir: output.dir,
            file: output.file,
            format: output.format,
            name: output.name,
            entryFileNames: output.entryFileNames,
            chunkFileNames: output.chunkFileNames,
            assetFileNames: output.assetFileNames,
            minify: output.minify,
            sourcemap: output.sourcemap,
            inlineDynamicImports: output.inlineDynamicImports,
            ...(output.chunkGroups?.length ? { advancedChunks: { groups: output.chunkGroups } } : {}),
        };
        for (const key of Object.keys(outputOptions)) if (outputOptions[key] === undefined) delete outputOptions[key];

        try {
            const result = write ? await bundle.write(outputOptions) : await bundle.generate(outputOptions);
            return result.output.map((item: any): OutputItem =>
                item.type === 'chunk'
                    ? {
                          type: 'chunk',
                          fileName: item.fileName,
                          name: item.name,
                          code: item.code,
                          isEntry: item.isEntry,
                          facadeModuleId: item.facadeModuleId ?? null,
                          imports: item.imports ?? [],
                          moduleIds: item.moduleIds ?? [],
                      }
                    : { type: 'asset', fileName: item.fileName, source: item.source },
            );
        } finally {
            await bundle.close();
        }
    },
};
