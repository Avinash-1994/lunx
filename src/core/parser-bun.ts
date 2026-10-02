/**
 * Bun.js Parser & Transformer
 * Day 3: Module 1 - Speed Mastery
 * 
 * Provides ultra-fast parsing and transformation using Bun's native API.
 * Falls back to SWC/esbuild if not running in Bun runtime.
 */

import * as path from 'path';
import { log } from '../utils/logger.js';
import { createRequire } from 'module';

// Types for Bun's Transpiler API
interface BunTranspilerOptions {
    loader?: 'js' | 'jsx' | 'ts' | 'tsx';
    target?: 'browser' | 'bun' | 'node';
    define?: Record<string, string>;
    exports?: 'auto' | 'default' | 'named';
    platform?: 'browser' | 'bun' | 'node';
}

interface BunTranspiler {
    transform(code: string, options?: BunTranspilerOptions): Promise<string>;
    transformSync(code: string, loader?: 'js' | 'jsx' | 'ts' | 'tsx'): string;
    scan(code: string): { exports: string[]; imports: any[] };
    scanImports(code: string): any[];
}

declare global {
    var Bun: {
        Transpiler: new (options?: BunTranspilerOptions) => BunTranspiler;
        version: string;
        spawn: any;
        write: any;
        file: any;
    } | undefined;
}

export class BunParser {
    private transpiler: BunTranspiler | null = null;
    private isBunRuntime: boolean;

    constructor() {
        this.isBunRuntime = typeof Bun !== 'undefined';
        if (this.isBunRuntime) {
            this.transpiler = new Bun!.Transpiler({
                loader: 'tsx', // Default loader, can be overridden per file
                target: 'browser'
            });
            log.info(`🚀 using native Bun parser v${Bun!.version}`);
        } else {
            // Node.js runtime: Use SWC transpiler (built-in dependency)
            // This is the expected behavior for non-Bun runtimes
            log.debug('Node.js runtime detected. Using SWC transpiler.');
        }
    }

    /**
     * specialized transform for specific loaders
     */
    async transform(code: string, filePath: string, options: { isDev: boolean, define?: Record<string, string> }): Promise<{ code: string; map?: string }> {
        const ext = path.extname(filePath);
        const loader = this.getLoader(ext);

        if (this.isBunRuntime && this.transpiler) {
            try {
                // Use native Bun.transpiler (Ultra fast)
                // Use transformSync for synchronous, faster execution
                // Bun's transpiler.transform() expects (code, loader) not (code, {loader})
                const result = this.transpiler.transformSync(code, loader);

                // Bun transpiler doesn't return source maps directly in transform() yet in all versions
                // newer versions do. Assuming string output for now.
                return { code: result, map: undefined };
            } catch (err: any) {
                log.error(`Bun transform failed for ${filePath}: ${err.message}`);
                throw err;
            }
        } else {
            // Not running in Bun runtime
            // Per MODULE 1 plan: "Keep SWC as fallback for edge cases"
            // Spawning Bun subprocess is too slow (~10ms per file)
            // Use esbuild directly instead (same as v1.0 fallback)
            const esbuild = await import('../lib/esbuild-compat.js');
            try {
                const result = await esbuild.transform(code, {
                    loader: loader as any,
                    target: 'es2020',
                    format: 'esm'
                });
                return {
                    code: result.code,
                    map: result.map
                };
            } catch (err: any) {
                log.error(`esbuild fallback failed for ${filePath}: ${err.message}`);
                throw err;
            }
        }
    }

    private getLoader(ext: string): 'js' | 'jsx' | 'ts' | 'tsx' {
        switch (ext) {
            case '.ts': return 'ts';
            case '.tsx': return 'tsx';
            case '.jsx': return 'jsx';
            default: return 'js';
        }
    }



    /**
     * Check if we are running in Bun
     */
    isBun(): boolean {
        return this.isBunRuntime;
    }
}

export const bunParser = new BunParser();
