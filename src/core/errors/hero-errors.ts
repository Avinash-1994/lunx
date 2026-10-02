/**
 * Hero Errors System
 * 
 * Provides rich, contextual error messages with:
 * - File chain visualization
 * - Graph explanation
 * - Suggested fixes
 * - Related documentation
 * 
 * Never show "Build failed" without context.
 */

import kleur from '../../lib/colors.js';
import path from 'path';

export interface ErrorContext {
    code: string;
    message: string;
    file?: string;
    line?: number;
    column?: number;
    stack?: string;
    fileChain?: string[];
    graphExplanation?: string;
    suggestedFix?: string;
    relatedDocs?: string[];
    severity: 'error' | 'warning' | 'info';
}

export class HeroError extends Error {
    public readonly context: ErrorContext;

    constructor(context: ErrorContext) {
        super(context.message);
        this.name = 'HeroError';
        this.context = context;
    }

    /**
     * Format error for display with rich context
     */
    format(): string {
        const lines: string[] = [];
        const { context } = this;
        const width = process.stdout.columns || 80;

        // 1. Header (Minimal & Urgent)
        lines.push('');
        lines.push(kleur.bgRed().bold().white(` ${context.code} `) + ' ' + kleur.red(context.message));
        lines.push('');

        // 2. Code Frame (The most important part)
        if (context.file && context.line) {
            lines.push(kleur.cyan(`╭─[${context.file}:${context.line}:${context.column || 1}]`));

            try {
                const fs = require('fs');
                if (fs.existsSync(context.file)) {
                    const content = fs.readFileSync(context.file, 'utf-8');
                    const fileLines = content.split('\n');
                    const start = Math.max(0, context.line - 3);
                    const end = Math.min(fileLines.length, context.line + 2);

                    for (let i = start; i < end; i++) {
                        const lineNum = i + 1;
                        const isErrorLine = lineNum === context.line;
                        const gutter = isErrorLine ? kleur.red(` ${lineNum} │ `) : kleur.dim(` ${lineNum} │ `);
                        const code = fileLines[i];

                        if (isErrorLine) {
                            lines.push(gutter + code);
                            if (context.column) {
                                // Add pointer
                                const padding = ' '.repeat(String(lineNum).length + 3 + context.column - 1);
                                lines.push(kleur.red(padding + '^'));
                            }
                        } else {
                            lines.push(gutter + kleur.dim(code));
                        }
                    }
                }
            } catch (e) {
                // Ignore code frame errors
            }
            lines.push(kleur.cyan('╰────'));
            lines.push('');
        }

        // 3. Causality & Hints
        if (context.graphExplanation) {
            lines.push(kleur.yellow('Caused by:'));
            lines.push(kleur.dim(`  ${context.graphExplanation}`));
            lines.push('');
        }

        if (context.suggestedFix) {
            lines.push(kleur.green('💡 Suggestion:'));
            context.suggestedFix.split('\n').forEach(line => {
                lines.push(`  ${line}`);
            });
            lines.push('');
        }

        if (context.relatedDocs && context.relatedDocs.length > 0) {
            lines.push(kleur.blue('📚 Docs: ') + kleur.underline(context.relatedDocs[0]));
        }

        lines.push('');
        return lines.join('\n');
    }

    /**
     * Display error to console
     */
    display(): void {
        console.error(this.format());
    }
}

/**
 * Error Registry - 10 High-Impact Errors
 */

// 1. Module Not Found
export function createModuleNotFoundError(
    modulePath: string,
    importedFrom: string,
    fileChain: string[]
): HeroError {
    return new HeroError({
        code: 'MODULE_NOT_FOUND',
        message: `Cannot resolve module '${modulePath}'`,
        file: importedFrom,
        fileChain,
        graphExplanation: `The module '${modulePath}' was imported but could not be found in the dependency graph. This breaks the module resolution chain.`,
        suggestedFix: `1. Check if the file exists at: ${modulePath}\n2. Verify the import path is correct\n3. If it's an npm package, run: npm install ${modulePath}\n4. Check your lunx.config resolve.alias settings`,
        relatedDocs: [
            'https://lunx.dev/docs/module-resolution',
            'https://lunx.dev/docs/troubleshooting#module-not-found'
        ],
        severity: 'error'
    });
}

// 2. Circular Dependency Detected
export function createCircularDependencyError(
    cycle: string[]
): HeroError {
    return new HeroError({
        code: 'CIRCULAR_DEPENDENCY',
        message: 'Circular dependency detected in module graph',
        fileChain: cycle,
        graphExplanation: `A circular dependency creates an infinite loop in the module graph. This can cause runtime errors and unpredictable behavior.`,
        suggestedFix: `1. Refactor to break the circular dependency\n2. Extract shared code into a separate module\n3. Use dependency injection or lazy loading\n4. Consider using dynamic imports: import('./module')`,
        relatedDocs: [
            'https://lunx.dev/docs/circular-dependencies',
            'https://lunx.dev/docs/best-practices#module-design'
        ],
        severity: 'error'
    });
}

// 3. CSS Import Failed
export function createCSSImportError(
    cssFile: string,
    reason: string,
    importedFrom?: string
): HeroError {
    return new HeroError({
        code: 'CSS_IMPORT_FAILED',
        message: `Failed to process CSS file: ${cssFile}`,
        file: cssFile,
        fileChain: importedFrom ? [importedFrom, cssFile] : [cssFile],
        graphExplanation: `CSS files are first-class nodes in Lunx's dependency graph. This CSS file could not be processed, breaking the graph.`,
        suggestedFix: `1. Check CSS syntax: ${reason}\n2. Verify PostCSS config if using preprocessors\n3. Check for missing @import files\n4. Run: lunx verify --explain to diagnose`,
        relatedDocs: [
            'https://lunx.dev/docs/css-handling',
            'https://lunx.dev/docs/postcss-integration'
        ],
        severity: 'error'
    });
}

// 4. Framework Adapter Missing
export function createFrameworkAdapterMissingError(
    framework: string
): HeroError {
    return new HeroError({
        code: 'FRAMEWORK_ADAPTER_MISSING',
        message: `Framework adapter not found: ${framework}`,
        graphExplanation: `Lunx requires a framework adapter to transform framework-specific code. The adapter for '${framework}' is not installed.`,
        suggestedFix: `1. Install the adapter: npm install @lunx/framework-${framework.toLowerCase()}\n2. Add to lunx.config:\n   import ${framework.toLowerCase()} from '@lunx/framework-${framework.toLowerCase()}';\n   export default { framework: ${framework.toLowerCase()}() }`,
        relatedDocs: [
            'https://lunx.dev/docs/framework-adapters',
            `https://lunx.dev/docs/frameworks/${framework.toLowerCase()}`
        ],
        severity: 'error'
    });
}

// 5. Invalid Config
export function createInvalidConfigError(
    configPath: string,
    validationErrors: string[]
): HeroError {
    return new HeroError({
        code: 'INVALID_CONFIG',
        message: 'Configuration file is invalid',
        file: configPath,
        graphExplanation: `The lunx.config file failed validation. This prevents the build from starting.`,
        suggestedFix: `Fix the following validation errors:\n${validationErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nRun: lunx verify --explain for detailed diagnostics`,
        relatedDocs: [
            'https://lunx.dev/docs/configuration',
            'https://lunx.dev/docs/config-schema'
        ],
        severity: 'error'
    });
}

// 6. Build Cache Corrupted
export function createCacheCorruptedError(
    cachePath: string
): HeroError {
    return new HeroError({
        code: 'CACHE_CORRUPTED',
        message: 'Build cache is corrupted',
        file: cachePath,
        graphExplanation: `The SQLite build cache has become corrupted. This can happen due to interrupted builds or disk errors.`,
        suggestedFix: `1. Delete the cache: rm -rf ${cachePath}\n2. Rebuild: lunx build\n3. If issue persists, check disk health\n4. Consider disabling cache temporarily: lunx build --no-cache`,
        relatedDocs: [
            'https://lunx.dev/docs/caching',
            'https://lunx.dev/docs/troubleshooting#cache-issues'
        ],
        severity: 'warning'
    });
}

// 7. HMR Connection Failed
export function createHMRConnectionError(
    port: number,
    reason: string
): HeroError {
    return new HeroError({
        code: 'HMR_CONNECTION_FAILED',
        message: `Hot Module Replacement connection failed on port ${port}`,
        graphExplanation: `The HMR WebSocket connection could not be established. This prevents live updates during development.`,
        suggestedFix: `1. Check if port ${port} is available\n2. Verify firewall settings\n3. Try a different port: lunx dev --port ${port + 1}\n4. Check browser console for WebSocket errors\n\nReason: ${reason}`,
        relatedDocs: [
            'https://lunx.dev/docs/hmr',
            'https://lunx.dev/docs/dev-server#troubleshooting'
        ],
        severity: 'warning'
    });
}

// 8. Asset Resolution Failed
export function createAssetResolutionError(
    assetPath: string,
    importedFrom: string
): HeroError {
    return new HeroError({
        code: 'ASSET_RESOLUTION_FAILED',
        message: `Cannot resolve asset: ${assetPath}`,
        file: importedFrom,
        fileChain: [importedFrom, assetPath],
        graphExplanation: `Assets (images, fonts, etc.) are tracked in the dependency graph. This asset could not be found.`,
        suggestedFix: `1. Check if file exists: ${assetPath}\n2. Verify the path is correct\n3. Check public directory configuration\n4. Ensure file extension is supported`,
        relatedDocs: [
            'https://lunx.dev/docs/assets',
            'https://lunx.dev/docs/static-assets'
        ],
        severity: 'error'
    });
}

// 9. TypeScript Compilation Error
export function createTypeScriptError(
    file: string,
    line: number,
    column: number,
    message: string,
    code: string
): HeroError {
    return new HeroError({
        code: 'TYPESCRIPT_ERROR',
        message: `TypeScript compilation failed: ${message}`,
        file,
        line,
        column,
        graphExplanation: `TypeScript type checking failed. While Lunx uses esbuild for fast transpilation, type errors indicate potential runtime issues.`,
        suggestedFix: `1. Fix the type error at ${file}:${line}:${column}\n2. Run: npx tsc --noEmit for full type checking\n3. Check tsconfig.json settings\n4. Error code: ${code}`,
        relatedDocs: [
            'https://lunx.dev/docs/typescript',
            `https://www.typescriptlang.org/docs/handbook/error.html#${code}`
        ],
        severity: 'error'
    });
}

// 10. Plugin Hook Error
export function createPluginHookError(
    pluginName: string,
    hookName: string,
    error: Error
): HeroError {
    return new HeroError({
        code: 'PLUGIN_HOOK_ERROR',
        message: `Plugin '${pluginName}' failed in '${hookName}' hook`,
        graphExplanation: `A plugin hook threw an error during the build process. This indicates a bug in the plugin or incompatibility.`,
        suggestedFix: `1. Check plugin version compatibility\n2. Review plugin configuration\n3. Try disabling the plugin temporarily\n4. Report issue to plugin author\n\nOriginal error: ${error.message}`,
        relatedDocs: [
            'https://lunx.dev/docs/plugins',
            'https://lunx.dev/docs/plugin-api'
        ],
        severity: 'error',
        stack: error.stack
    });
}

/**
 * Wrap any error in a HeroError with context
 */
export function wrapError(error: Error, context?: Partial<ErrorContext>): HeroError {
    if (error instanceof HeroError) {
        return error;
    }

    return new HeroError({
        code: 'UNKNOWN_ERROR',
        message: error.message,
        stack: error.stack,
        severity: 'error',
        suggestedFix: 'This is an unexpected error. Please report it to: https://github.com/Avinash-1994/lunx/issues',
        relatedDocs: ['https://lunx.dev/docs/troubleshooting'],
        ...context
    });
}

/**
 * Print a Hero Error to the console
 */
export function printHeroError(error: HeroError): void {
    error.display();
}
