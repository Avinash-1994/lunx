/**
 * Rolldown Bundler Adapter
 * Day 4: Module 1 - Speed Mastery
 * 
 * Provides ultra-fast bundling using Rolldown (Rust-based Rollup replacement).
 * Delivers 1.8x - 2x faster production builds compared to esbuild/Rollup.
 */

// Rolldown is an optional accelerator, not a dependency of lunx, so it is
// loaded on demand: a static import took this whole module down with
// ERR_MODULE_NOT_FOUND wherever it is not installed.
import type { RolldownOptions, OutputOptions } from 'rolldown';

async function loadRolldown() {
    try {
        return (await import('rolldown')).rolldown;
    } catch {
        throw new Error(
            [
                'The Rolldown bundler is not installed.',
                '  Install it with:  npm i -D rolldown',
            ].join(String.fromCharCode(10))
        );
    }
}
import path from 'path';
import fs from 'fs/promises';
import { log } from '../utils/logger.js';
import { performance } from 'perf_hooks';

export interface BundleOptions {
    input: string | string[];
    outDir: string;
    format?: 'esm' | 'cjs' | 'iife' | 'umd';
    sourcemap?: boolean | 'inline' | 'hidden';
    minify?: boolean;
    splitting?: boolean;
    target?: string;
    external?: string[];
    entryFileNames?: string;
    chunkFileNames?: string;
    assetFileNames?: string;
    define?: Record<string, string>;
    metafile?: boolean;
}

export interface BundleResult {
    duration: number;
    files: string[];
    assets: string[];
    errors: any[];
    warnings: any[];
    metafile?: any;
}

export class RolldownBundler {
    constructor() {
        log.info('🚀 Initialized Rolldown Bundler (Rust-powered)');
    }

    /**
     * Build the project using Rolldown
     */
    async build(options: BundleOptions): Promise<BundleResult> {
        const start = performance.now();
        const files: string[] = [];
        const assets: string[] = [];
        const warnings: any[] = [];

        try {
            // Map generic options to Rolldown options
            const inputOptions: RolldownOptions = {
                input: options.input,
                external: options.external,
                treeshake: true, // Enabled by default in Rolldown for production
                // define: options.define, // Removed as it caused warning in current version
                // Add plugins here if needed
                platform: 'node', // Default to node for now, or detect? Rolldown default is neutral/node-like
                resolve: {
                    // Rolldown specific resolve options if needed
                }
            };

            const outputOptions: OutputOptions = {
                dir: options.outDir,
                format: options.format || 'esm',
                sourcemap: options.sourcemap === 'inline' ? 'inline' : !!options.sourcemap,
                minify: options.minify,
                entryFileNames: options.entryFileNames || '[name].js',
                chunkFileNames: options.chunkFileNames || '[name]-[hash].js',
                assetFileNames: options.assetFileNames || 'assets/[name]-[hash][extname]',
                // splitting: options.splitting // Code splitting is automatic in Rolldown when multiple inputs or dynamic imports
            };

            // Create bundle
            const rolldown = await loadRolldown();
            const builder = await rolldown(inputOptions);

            // Generate output
            const { output } = await builder.write(outputOptions);

            // Process results
            for (const chunkOrAsset of output) {
                if (chunkOrAsset.type === 'chunk') {
                    files.push(path.join(options.outDir, chunkOrAsset.fileName));
                } else {
                    assets.push(path.join(options.outDir, chunkOrAsset.fileName));
                }
            }

            const end = performance.now();
            const duration = end - start;

            log.success(`Rolldown build complete in ${duration.toFixed(2)}ms`);

            return {
                duration,
                files,
                assets,
                errors: [], // Rolldown throws on errors
                warnings
            };

        } catch (error: any) {
            log.error('Rolldown build failed:', error);
            return {
                duration: performance.now() - start,
                files: [],
                assets: [],
                errors: [error],
                warnings
            };
        }
    }

    /**
     * Run a multi-target build (e.g. ESM + CJS)
     */
    async buildLibrary(input: string, outDir: string, targets: Array<'esm' | 'cjs' | 'umd'>): Promise<BundleResult[]> {
        const results: BundleResult[] = [];

        for (const format of targets) {
            const result = await this.build({
                input,
                outDir: path.join(outDir, format),
                format,
                sourcemap: true,
                minify: true
            });
            results.push(result);
        }

        return results;
    }
}

export const rolldownBundler = new RolldownBundler();
