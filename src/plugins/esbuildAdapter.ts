import type { Plugin as EsbuildPlugin } from 'esbuild';
import { PluginManager } from './index.js';
import path from 'path';
import fs from 'fs/promises';

import { UniversalTransformer } from '../core/universal-transformer.js';
import { log } from '../utils/logger.js';

export function createEsbuildPlugin(pm: PluginManager, root: string): EsbuildPlugin {
    const universalTransformer = new UniversalTransformer(root);

    return {
        name: 'lunx-adapter',
        setup(build) {
            build.onLoad({ filter: /.*/ }, async (args) => {
                // Skip node_modules (unless we strictly need to transform them, but usually not for libs)
                if (args.path.includes('node_modules')) return;

                const ext = path.extname(args.path);
                // console.log(`[Adapter] Loading file: ${args.path} (ext: ${ext})`);

                // Handle Framework Components via Universal Transformer
                const frameworkExtensions: Record<string, string> = {
                    '.vue': 'vue',
                    '.svelte': 'svelte',
                    '.astro': 'astro',
                    '.tsx': 'react',
                    '.jsx': 'react',
                    '.ts': 'vanilla' // We will check for lit/angular inside
                };

                if (frameworkExtensions[ext]) {
                    let raw = await fs.readFile(args.path, 'utf-8');
                    let framework = frameworkExtensions[ext];

                    // Framework-specific heuristics
                    if (raw.includes('@builder.io/qwik')) framework = 'qwik';
                    if (raw.includes('@customElement') || raw.includes('lit-element')) framework = 'lit';
                    if (raw.includes('@Component') && raw.includes('@angular/core')) framework = 'angular';

                    console.log(`[Adapter] Transforming ${args.path} with ${framework}`);

                    try {
                        const result = await universalTransformer.transform({
                            code: raw,
                            filePath: args.path,
                            isDev: false, // Production build
                            framework: framework as any,
                            root: root
                        });
                        return {
                            contents: result.code,
                            loader: 'js', // Clean JS after transform
                        };
                    } catch (e: any) {
                        log.error(`Failed to transform ${args.path}: ${e.message}`);
                        return { errors: [{ text: e.message }] };
                    }
                }

                // Handle standard JS/TS extensions possibly via PluginManager
                if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
                    let raw = await fs.readFile(args.path, 'utf-8');
                    // Use PluginManager for additional transforms
                    const transformed = await pm.transform(raw, args.path);
                    return {
                        contents: transformed,
                        loader: ext.slice(1) as any,
                    };
                }

                // Handle CSS and Preprocessors
                if (['.css', '.scss', '.sass', '.less', '.styl'].includes(ext)) {
                    let raw = await fs.readFile(args.path, 'utf-8');
                    const transformed = await pm.transform(raw, args.path);
                    return {
                        contents: transformed,
                        loader: 'css',
                    };
                }

                return;
            });
        },
    };
}
