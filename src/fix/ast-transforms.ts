import { parse as parseModule } from '../lib/oxc.js';
import * as walk from '../lib/ast-walk.js';

/**
 * Auto-Fix Engine
 * Safe AST transforms for common build issues
 */

export interface FixResult {
    success: boolean;
    code?: string;
    error?: string;
    changes: FixChange[];
}

export interface FixChange {
    type: 'remove-unused-import' | 'add-dynamic-import' | 'add-aria' | 'remove-unused-export' | 'tree-shake';
    location: { line: number; column: number };
    description: string;
}

export interface ModuleInfo {
    path: string;
    exports: Set<string>;
    imports: Map<string, string[]>; // module -> imported names
}

export class AutoFixEngine {
    private transformHistory: Map<string, string[]> = new Map(); // file -> [original, transform1, transform2, ...]

    /**
     * Save original code for potential rollback
     */
    saveSnapshot(filePath: string, code: string): void {
        if (!this.transformHistory.has(filePath)) {
            this.transformHistory.set(filePath, [code]);
        } else {
            this.transformHistory.get(filePath)!.push(code);
        }
    }

    /**
     * Rollback to previous version
     */
    rollback(filePath: string, steps: number = 1): string | null {
        const history = this.transformHistory.get(filePath);
        if (!history || history.length <= steps) {
            return null;
        }

        // Remove the last 'steps' versions
        for (let i = 0; i < steps; i++) {
            history.pop();
        }

        // Return the current version
        return history[history.length - 1];
    }

    /**
     * Get rollback history for a file
     */
    getHistory(filePath: string): string[] {
        return this.transformHistory.get(filePath) || [];
    }

    /**
     * Clear history for a file
     */
    clearHistory(filePath: string): void {
        this.transformHistory.delete(filePath);
    }

    /**
     * Remove unused imports from code
     */
    removeUnusedImports(code: string, unusedImports: string[]): FixResult {
        const changes: FixChange[] = [];

        try {
            const lines = code.split('\n');
            const newLines: string[] = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                let shouldRemove = false;

                // Check if this line contains an unused import
                for (const unusedImport of unusedImports) {
                    const importRegex = new RegExp(`import\\s+.*${unusedImport}.*from`, 'g');
                    if (importRegex.test(line)) {
                        shouldRemove = true;
                        changes.push({
                            type: 'remove-unused-import',
                            location: { line: i + 1, column: 0 },
                            description: `Removed unused import: ${unusedImport}`
                        });
                        break;
                    }
                }

                if (!shouldRemove) {
                    newLines.push(line);
                }
            }

            return {
                success: true,
                code: newLines.join('\n'),
                changes
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                changes: []
            };
        }
    }

    /**
     * Add dynamic imports for large dependencies
     */
    addDynamicImport(code: string, moduleName: string, threshold: number = 100 * 1024): FixResult {
        const changes: FixChange[] = [];

        try {
            // Replace static import with dynamic import
            const importRegex = new RegExp(`import\\s+(.+)\\s+from\\s+['"]${moduleName}['"]`, 'g');

            let newCode = code;
            let match;

            while ((match = importRegex.exec(code)) !== null) {
                const importedNames = match[1];
                const lineNumber = code.substring(0, match.index).split('\n').length;

                // Replace with dynamic import
                const dynamicImport = `const ${importedNames} = await import('${moduleName}')`;
                newCode = newCode.replace(match[0], dynamicImport);

                changes.push({
                    type: 'add-dynamic-import',
                    location: { line: lineNumber, column: match.index },
                    description: `Converted to dynamic import: ${moduleName}`
                });
            }

            return {
                success: true,
                code: newCode,
                changes
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                changes: []
            };
        }
    }

    /**
     * Add ARIA attributes to improve accessibility
     */
    addAriaAttributes(html: string): FixResult {
        const changes: FixChange[] = [];

        try {
            let newHtml = html;

            // Add aria-label to buttons without text
            const buttonRegex = /<button([^>]*)>(\s*)<\/button>/g;
            newHtml = newHtml.replace(buttonRegex, (match, attrs, content) => {
                if (!attrs.includes('aria-label')) {
                    changes.push({
                        type: 'add-aria',
                        location: { line: 0, column: 0 },
                        description: 'Added aria-label to button'
                    });
                    return `<button${attrs} aria-label="Button">${content}</button>`;
                }
                return match;
            });

            // Add alt to images
            const imgRegex = /<img([^>]*)>/g;
            newHtml = newHtml.replace(imgRegex, (match, attrs) => {
                if (!attrs.includes('alt=')) {
                    changes.push({
                        type: 'add-aria',
                        location: { line: 0, column: 0 },
                        description: 'Added alt attribute to image'
                    });
                    return `<img${attrs} alt="Image">`;
                }
                return match;
            });

            // Convert non-semantic divs to semantic HTML
            // Convert <div class="header"> to <header>
            newHtml = newHtml.replace(/<div([^>]*class=["'].*?header.*?["'][^>]*)>/gi, (match, attrs) => {
                changes.push({
                    type: 'add-aria',
                    location: { line: 0, column: 0 },
                    description: 'Converted div to semantic <header>'
                });
                return `<header${attrs.replace(/class=["'].*?header.*?["']/, '')}>`;
            });

            // Convert <div class="nav"> to <nav>
            newHtml = newHtml.replace(/<div([^>]*class=["'].*?nav.*?["'][^>]*)>/gi, (match, attrs) => {
                changes.push({
                    type: 'add-aria',
                    location: { line: 0, column: 0 },
                    description: 'Converted div to semantic <nav>'
                });
                return `<nav${attrs.replace(/class=["'].*?nav.*?["']/, '')}>`;
            });

            // Convert <div class="main"> to <main>
            newHtml = newHtml.replace(/<div([^>]*class=["'].*?main.*?["'][^>]*)>/gi, (match, attrs) => {
                changes.push({
                    type: 'add-aria',
                    location: { line: 0, column: 0 },
                    description: 'Converted div to semantic <main>'
                });
                return `<main${attrs.replace(/class=["'].*?main.*?["']/, '')}>`;
            });

            // Convert <div class="footer"> to <footer>
            newHtml = newHtml.replace(/<div([^>]*class=["'].*?footer.*?["'][^>]*)>/gi, (match, attrs) => {
                changes.push({
                    type: 'add-aria',
                    location: { line: 0, column: 0 },
                    description: 'Converted div to semantic <footer>'
                });
                return `<footer${attrs.replace(/class=["'].*?footer.*?["']/, '')}>`;
            });

            return {
                success: true,
                code: newHtml,
                changes
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                changes: []
            };
        }
    }

    /**
     * Remove unused exports
     */
    removeUnusedExports(code: string, unusedExports: string[]): FixResult {
        const changes: FixChange[] = [];

        try {
            const lines = code.split('\n');
            const newLines: string[] = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                let shouldRemove = false;

                // Check if this line contains an unused export
                for (const unusedExport of unusedExports) {
                    const exportRegex = new RegExp(`export\\s+(const|function|class)\\s+${unusedExport}`, 'g');
                    if (exportRegex.test(line)) {
                        shouldRemove = true;
                        changes.push({
                            type: 'remove-unused-export',
                            location: { line: i + 1, column: 0 },
                            description: `Removed unused export: ${unusedExport}`
                        });
                        break;
                    }
                }

                if (!shouldRemove) {
                    newLines.push(line);
                }
            }

            return {
                success: true,
                code: newLines.join('\n'),
                changes
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                changes: []
            };
        }
    }

    /**
     * Validate that a transform is safe
     */
    validateTransform(originalCode: string, transformedCode: string): boolean {
        try {
            // Try to parse both versions
            parseModule('module.js', originalCode, 'js');
            parseModule('module.js', transformedCode, 'js');

            // Both parse successfully, transform is safe
            return true;
        } catch {
            // Parsing failed, transform is unsafe
            return false;
        }
    }

    /**
     * Generate diff preview
     */
    generateDiff(original: string, modified: string): string {
        const originalLines = original.split('\n');
        const modifiedLines = modified.split('\n');
        const diff: string[] = [];

        const maxLines = Math.max(originalLines.length, modifiedLines.length);

        for (let i = 0; i < maxLines; i++) {
            const origLine = originalLines[i] || '';
            const modLine = modifiedLines[i] || '';

            if (origLine !== modLine) {
                if (origLine) diff.push(`- ${origLine}`);
                if (modLine) diff.push(`+ ${modLine}`);
            }
        }

        return diff.join('\n');
    }

    /**
     * Apply batch fixes
     */
    applyBatchFixes(code: string, fixes: Array<{ type: string; data: any }>): FixResult {
        let currentCode = code;
        const allChanges: FixChange[] = [];

        for (const fix of fixes) {
            let result: FixResult;

            switch (fix.type) {
                case 'remove-unused-imports':
                    result = this.removeUnusedImports(currentCode, fix.data.imports);
                    break;
                case 'add-dynamic-import':
                    result = this.addDynamicImport(currentCode, fix.data.module);
                    break;
                case 'add-aria':
                    result = this.addAriaAttributes(currentCode);
                    break;
                case 'remove-unused-exports':
                    result = this.removeUnusedExports(currentCode, fix.data.exports);
                    break;
                default:
                    continue;
            }

            if (result.success && result.code) {
                // Validate before applying
                if (this.validateTransform(currentCode, result.code)) {
                    currentCode = result.code;
                    allChanges.push(...result.changes);
                }
            }
        }

        return {
            success: true,
            code: currentCode,
            changes: allChanges
        };
    }

    /**
     * Tree-shaking: Analyze module graph and remove unused exports
     */
    treeShake(modules: Map<string, string>): Map<string, FixResult> {
        const results = new Map<string, FixResult>();
        const moduleInfo = new Map<string, ModuleInfo>();

        // Step 1: Analyze all modules to find exports and imports
        for (const [path, code] of modules) {
            try {
                const ast = parseModule('module.js', code, 'js');
                const exports = new Set<string>();
                const imports = new Map<string, string[]>();

                walk.simple(ast, {
                    ExportNamedDeclaration(node: any) {
                        if (node.declaration) {
                            if (node.declaration.type === 'VariableDeclaration') {
                                node.declaration.declarations.forEach((decl: any) => {
                                    if (decl.id.name) exports.add(decl.id.name);
                                });
                            } else if (node.declaration.id) {
                                exports.add(node.declaration.id.name);
                            }
                        }
                        if (node.specifiers) {
                            node.specifiers.forEach((spec: any) => {
                                exports.add(spec.exported.name);
                            });
                        }
                    },
                    ImportDeclaration(node: any) {
                        const source = node.source.value;
                        const importedNames: string[] = [];
                        node.specifiers.forEach((spec: any) => {
                            if (spec.imported) {
                                importedNames.push(spec.imported.name);
                            } else if (spec.local) {
                                importedNames.push(spec.local.name);
                            }
                        });
                        imports.set(source, importedNames);
                    }
                });

                moduleInfo.set(path, { path, exports, imports });
            } catch (error) {
                // Skip modules that can't be parsed
            }
        }

        // Step 2: Find which exports are actually used
        const usedExports = new Map<string, Set<string>>();

        // Helper to normalize paths
        const normalizePath = (importPath: string, fromPath: string): string => {
            // Remove ./ prefix
            if (importPath.startsWith('./')) {
                importPath = importPath.substring(2);
            }
            // Remove ../ (simplified - just use basename)
            if (importPath.includes('../')) {
                const parts = importPath.split('/');
                importPath = parts[parts.length - 1];
            }
            return importPath;
        };

        for (const [path, info] of moduleInfo) {
            for (const [importSource, importedNames] of info.imports) {
                const normalizedSource = normalizePath(importSource, path);
                if (!usedExports.has(normalizedSource)) {
                    usedExports.set(normalizedSource, new Set());
                }
                importedNames.forEach(name => {
                    usedExports.get(normalizedSource)!.add(name);
                });
            }
        }

        // Step 3: Remove unused exports from each module
        for (const [path, code] of modules) {
            const info = moduleInfo.get(path);
            if (!info) {
                results.set(path, {
                    success: true,
                    code,
                    changes: []
                });
                continue;
            }

            const used = usedExports.get(path) || new Set();
            const unusedExports = Array.from(info.exports).filter(exp => !used.has(exp));

            if (unusedExports.length > 0) {
                const result = this.removeUnusedExports(code, unusedExports);
                if (result.success && result.code) {
                    // Mark changes as tree-shake type
                    const treeShakeChanges = result.changes.map(change => ({
                        ...change,
                        type: 'tree-shake' as const,
                        description: `Tree-shaking: ${change.description}`
                    }));

                    results.set(path, {
                        success: true,
                        code: result.code,
                        changes: treeShakeChanges
                    });
                } else {
                    results.set(path, result);
                }
            } else {
                results.set(path, {
                    success: true,
                    code,
                    changes: []
                });
            }
        }

        return results;
    }

    /**
     * Track fix success rate
     */
    calculateSuccessRate(results: FixResult[]): number {
        const successful = results.filter(r => r.success).length;
        return results.length > 0 ? (successful / results.length) * 100 : 0;
    }
}
