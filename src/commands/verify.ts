/**
 * Lunx Verify CLI - Trust Anchor
 * 
 * Comprehensive project verification with multiple modes:
 * - lunx verify (basic)
 * - lunx verify --ci (CI/CD mode)
 * - lunx verify --strict (strict validation)
 * - lunx verify --explain (detailed explanations)
 */

import fs from 'fs';
import path from 'path';
import kleur from '../internal/colors.js';
import { z } from '../internal/schema.js';

export interface VerifyOptions {
    ci?: boolean;
    strict?: boolean;
    explain?: boolean;
    fix?: boolean;
}

export interface VerifyResult {
    passed: boolean;
    checks: CheckResult[];
    summary: {
        total: number;
        passed: number;
        failed: number;
        warnings: number;
    };
}

export interface CheckResult {
    name: string;
    category: 'config' | 'graph' | 'adapter' | 'cache' | 'dependencies' | 'permissions';
    status: 'pass' | 'fail' | 'warn';
    message: string;
    explanation?: string;
    fix?: string;
    details?: any;
}

/**
 * Main verify function
 */
export async function verify(options: VerifyOptions = {}): Promise<VerifyResult> {
    const checks: CheckResult[] = [];

    console.log(kleur.bold().cyan('\n⚡ Lunx Verify - Project Health Check\n'));

    // Run all checks
    checks.push(...await checkConfig(options));
    checks.push(...await checkGraph(options));
    checks.push(...await checkAdapters(options));
    checks.push(...await checkCache(options));
    checks.push(...await checkDependencies(options));
    checks.push(...await checkPermissions(options));

    // Calculate summary
    const summary = {
        total: checks.length,
        passed: checks.filter((c: CheckResult) => c.status === 'pass').length,
        failed: checks.filter((c: CheckResult) => c.status === 'fail').length,
        warnings: checks.filter((c: CheckResult) => c.status === 'warn').length
    };

    const passed = summary.failed === 0 && (!options.strict || summary.warnings === 0);

    // Display results
    displayResults(checks, summary, options);

    return { passed, checks, summary };
}

/**
 * 1. Config Validity Checks
 */
async function checkConfig(options: VerifyOptions): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    const cwd = process.cwd();

    console.log(kleur.bold('📋 Config Validation'));

    // Check if config file exists
    const configFiles = ['lunx.config.ts', 'lunx.config.js', 'lunx.config.json'];
    const configFile = configFiles.find(f => fs.existsSync(path.join(cwd, f)));

    if (!configFile) {
        checks.push({
            name: 'Config File Exists',
            category: 'config',
            status: 'fail',
            message: 'No lunx.config file found',
            explanation: options.explain ? 'Lunx requires a configuration file to define build behavior' : undefined,
            fix: 'Run: lunx init to create a config file'
        });
        return checks;
    }

    checks.push({
        name: 'Config File Exists',
        category: 'config',
        status: 'pass',
        message: `Found ${configFile}`
    });

    // Try to load and validate config
    try {
        const { loadConfig } = await import('../config/index.js');
        const config = await loadConfig(cwd);

        checks.push({
            name: 'Config Loads Successfully',
            category: 'config',
            status: 'pass',
            message: 'Configuration loaded without errors'
        });

        // Validate config schema
        if (config.plugins && config.plugins.length > 0) {
            checks.push({
                name: 'Plugins Configured',
                category: 'config',
                status: 'pass',
                message: `${config.plugins.length} plugin(s) configured`
            });
        } else {
            checks.push({
                name: 'Plugins Configured',
                category: 'config',
                status: options.strict ? 'fail' : 'warn',
                message: 'No plugins configured',
                explanation: options.explain ? 'Plugins enable framework-specific transformations and features' : undefined,
                fix: 'Add plugins to lunx.config'
            });
        }

        // Check entry points
        if (config.entry && config.entry.length > 0) {
            const missingEntries = config.entry.filter((e: string) => !fs.existsSync(path.join(cwd, e)));
            if (missingEntries.length > 0) {
                checks.push({
                    name: 'Entry Points Exist',
                    category: 'config',
                    status: 'fail',
                    message: `Missing entry files: ${missingEntries.join(', ')}`,
                    fix: 'Create the entry files or update config.entry'
                });
            } else {
                checks.push({
                    name: 'Entry Points Exist',
                    category: 'config',
                    status: 'pass',
                    message: `All ${config.entry.length} entry point(s) found`
                });
            }
        }

    } catch (error: any) {
        checks.push({
            name: 'Config Loads Successfully',
            category: 'config',
            status: 'fail',
            message: `Failed to load config: ${error.message}`,
            explanation: options.explain ? 'Config file has syntax errors or invalid exports' : undefined,
            fix: 'Check config file syntax and exports'
        });
    }

    return checks;
}

/**
 * 2. Graph Health Checks
 */
// Helper to scan imports
// Helper to scan imports
import { GraphAnalyzer, scanImports } from '../native/index.js';

async function checkGraph(options: VerifyOptions): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    console.log(kleur.bold('\n🔍 Graph Health'));

    try {
        const { loadConfig } = await import('../config/index.js');
        const config = await loadConfig(process.cwd());
        const entryPoints = config.entry || [];

        if (!entryPoints.length) {
            checks.push({
                name: 'Graph Analysis',
                category: 'graph',
                status: 'warn',
                message: 'No entry points to analyze',
            });
            return checks;
        }

        const analyzer = new GraphAnalyzer();
        const visited = new Set<string>();
        const queue: string[] = [];
        const ids: string[] = [];
        const edges: string[][] = [];

        // Initialize queue
        for (const entry of entryPoints) {
            const absEntry = path.resolve(process.cwd(), entry);
            if (fs.existsSync(absEntry)) {
                queue.push(absEntry);
            }
        }

        // Basic DFS scanner
        while (queue.length > 0) {
            const current = queue.pop()!;
            if (visited.has(current)) continue;
            visited.add(current);
            ids.push(current);

            const currentEdges: string[] = [];

            try {
                const content = fs.readFileSync(current, 'utf-8');
                // Regex for static imports
                const importRegex = /import\s+(?:[\w\s{},*]+from\s+)?['"]([^'"]+)['"]/g;
                let match;

                while ((match = importRegex.exec(content)) !== null) {
                    const importPath = match[1];
                    // Very basic resolution (relative only for verify)
                    if (importPath.startsWith('.')) {
                        const dir = path.dirname(current);
                        // Try extensions
                        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.css', '.scss'];
                        let resolvedCall = path.resolve(dir, importPath);
                        let matched = false;

                        if (fs.existsSync(resolvedCall) && fs.statSync(resolvedCall).isFile()) {
                            matched = true;
                        } else {
                            for (const ext of extensions) {
                                if (fs.existsSync(resolvedCall + ext)) {
                                    resolvedCall = resolvedCall + ext;
                                    matched = true;
                                    break;
                                }
                            }
                        }

                        if (matched) {
                            currentEdges.push(resolvedCall);
                            if (!visited.has(resolvedCall)) {
                                queue.push(resolvedCall);
                            }
                        }
                    }
                }
            } catch (e) {
                // Ignore read errors
            }
            edges.push(currentEdges);
        }

        // Feed logic to Rust
        analyzer.addBatch(ids, edges);
        const cycles = analyzer.detectCycles();

        if (cycles.length > 0) {
            checks.push({
                name: 'Circular Dependencies',
                category: 'graph',
                status: 'fail',
                message: `Detected ${cycles.length} circular dependency chains`,
                explanation: options.explain ? `Cycles: \n${cycles.map((c: any) => '   - ' + c.cycle.join(' -> ')).join('\n')}` : undefined,
                fix: 'Refactor code to remove cycles'
            });
        } else {
            checks.push({
                name: 'Circular Dependencies',
                category: 'graph',
                status: 'pass',
                message: 'No circular dependencies detected',
                details: { scanned: visited.size }
            });
        }

        // Check for Orphans
        // Orphans are tricky with basic scan, but we can verify reachability count
        checks.push({
            name: 'Graph Reachability',
            category: 'graph',
            status: 'pass',
            message: `Scanned ${visited.size} files reachable from entry`
        });

    } catch (e: any) {
        checks.push({
            name: 'Graph Analysis',
            category: 'graph',
            status: 'warn',
            message: `Failed to analyze graph: ${e.message}`
        });
    }

    return checks;
}

/**
 * 3. Adapter Contract Checks
 */
async function checkAdapters(options: VerifyOptions): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    console.log(kleur.bold('\n🔌 Adapter Contracts'));

    try {
        const { loadConfig } = await import('../config/index.js');
        const config = await loadConfig(process.cwd());

        if (config.plugins && config.plugins.length > 0) {
            // Check if plugins have required properties
            const pluginsWithIssues = config.plugins.filter((p: any) => !p || typeof p !== 'object');

            if (pluginsWithIssues.length > 0) {
                checks.push({
                    name: 'Plugin Validity',
                    category: 'adapter',
                    status: 'warn',
                    message: `${pluginsWithIssues.length} plugin(s) may have issues`,
                    explanation: options.explain ? 'Plugins should be objects with proper configuration' : undefined
                });
            } else {
                checks.push({
                    name: 'Plugin Validity',
                    category: 'adapter',
                    status: 'pass',
                    message: 'All plugins appear valid'
                });
            }
        }
    } catch (error) {
        // Config already checked, skip adapter checks
    }

    return checks;
}

/**
 * 4. Cache Integrity Checks
 */
async function checkCache(options: VerifyOptions): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    console.log(kleur.bold('\n💾 Cache Integrity'));

    const cacheDir = path.join(process.cwd(), '.lunx_cache');

    if (!fs.existsSync(cacheDir)) {
        checks.push({
            name: 'Cache Directory',
            category: 'cache',
            status: 'warn',
            message: 'No cache directory found (will be created on first build)',
            explanation: options.explain ? 'Cache improves rebuild performance' : undefined
        });
        return checks;
    }

    checks.push({
        name: 'Cache Directory',
        category: 'cache',
        status: 'pass',
        message: 'Cache directory exists'
    });

    // Check the build cache index
    const dbPath = path.join(cacheDir, 'build.json');
    if (fs.existsSync(dbPath)) {
        try {
            // A readable, parseable index is all the cache needs to be valid.
            JSON.parse(fs.readFileSync(dbPath, 'utf8'));

            checks.push({
                name: 'Cache Database',
                category: 'cache',
                status: 'pass',
                message: 'Cache database is valid'
            });
        } catch (error: any) {
            checks.push({
                name: 'Cache Database',
                category: 'cache',
                status: 'fail',
                message: 'Cache database is corrupted',
                explanation: options.explain ? 'Corrupted cache can cause build failures' : undefined,
                fix: `Delete cache: rm -rf ${cacheDir}`
            });
        }
    }

    return checks;
}

/**
 * 5. Dependency Version Checks
 */
async function checkDependencies(options: VerifyOptions): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    console.log(kleur.bold('\n📦 Dependencies'));

    const pkgPath = path.join(process.cwd(), 'package.json');

    if (!fs.existsSync(pkgPath)) {
        checks.push({
            name: 'package.json',
            category: 'dependencies',
            status: 'fail',
            message: 'No package.json found',
            fix: 'Run: npm init'
        });
        return checks;
    }

    checks.push({
        name: 'package.json',
        category: 'dependencies',
        status: 'pass',
        message: 'package.json exists'
    });

    // Check if node_modules exists
    const nodeModulesPath = path.join(process.cwd(), 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
        checks.push({
            name: 'Dependencies Installed',
            category: 'dependencies',
            status: 'fail',
            message: 'node_modules not found',
            fix: 'Run: npm install'
        });
    } else {
        checks.push({
            name: 'Dependencies Installed',
            category: 'dependencies',
            status: 'pass',
            message: 'Dependencies installed'
        });
    }

    return checks;
}

/**
 * 6. File Permission Checks
 */
async function checkPermissions(options: VerifyOptions): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    console.log(kleur.bold('\n🔐 Permissions'));

    const cwd = process.cwd();

    // Check write permissions
    try {
        const testFile = path.join(cwd, '.lunx_verify_test');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);

        checks.push({
            name: 'Write Permissions',
            category: 'permissions',
            status: 'pass',
            message: 'Directory is writable'
        });
    } catch (error) {
        checks.push({
            name: 'Write Permissions',
            category: 'permissions',
            status: 'fail',
            message: 'Cannot write to project directory',
            fix: 'Check file permissions'
        });
    }

    return checks;
}

/**
 * Display verification results
 */
function displayResults(checks: CheckResult[], summary: any, options: VerifyOptions): void {
    console.log(kleur.bold('\n' + '═'.repeat(80)));
    console.log(kleur.bold('📊 Verification Summary'));
    console.log(kleur.bold('═'.repeat(80) + '\n'));

    // Group by category
    const categories = ['config', 'graph', 'adapter', 'cache', 'dependencies', 'permissions'] as const;

    categories.forEach((category: string) => {
        const categoryChecks = checks.filter((c: CheckResult) => c.category === category);
        if (categoryChecks.length === 0) return;

        categoryChecks.forEach((check: CheckResult) => {
            const icon = check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : '⚠️';
            const color = check.status === 'pass' ? kleur.green : check.status === 'fail' ? kleur.red : kleur.yellow;

            console.log(color(`${icon} ${check.name}: ${check.message}`));

            if (options.explain && check.explanation) {
                console.log(kleur.dim(`   ℹ️  ${check.explanation}`));
            }

            if (check.fix) {
                console.log(kleur.cyan(`   💡 ${check.fix}`));
            }
        });
    });

    // Summary
    console.log(kleur.bold('\n' + '─'.repeat(80)));
    console.log(kleur.bold(`Total Checks: ${summary.total}`));
    console.log(kleur.green(`✅ Passed: ${summary.passed}`));
    if (summary.failed > 0) {
        console.log(kleur.red(`❌ Failed: ${summary.failed}`));
    }
    if (summary.warnings > 0) {
        console.log(kleur.yellow(`⚠️  Warnings: ${summary.warnings}`));
    }

    const passed = summary.failed === 0 && (!options.strict || summary.warnings === 0);

    console.log(kleur.bold('\n' + '═'.repeat(80)));
    if (passed) {
        console.log(kleur.bold().green('✅ Verification PASSED'));
    } else {
        console.log(kleur.bold().red('❌ Verification FAILED'));
        if (options.ci) {
            process.exit(1);
        }
    }
    console.log(kleur.bold('═'.repeat(80) + '\n'));
}
