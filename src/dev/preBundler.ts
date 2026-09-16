import path from 'path';
import fs from 'fs/promises';
import { build } from 'esbuild';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import { log } from '../utils/logger.js';
import native from '../native/index.js';

const require = createRequire(import.meta.url);

// Unified native loader — never hard-require lunx_native.node from cwd alone.
let _native: { prebundle: Function; prebundlePut: Function } | null | undefined;
function isRustNative(): boolean {
    try {
        return typeof (native as any).helloRust === 'function'
            && String((native as any).helloRust()) !== 'JS fallback';
    } catch {
        return false;
    }
}
function getNative() {
    if (_native !== undefined) return _native;
    if (isRustNative() && typeof (native as any).prebundle === 'function') {
        _native = native as { prebundle: Function; prebundlePut: Function };
        return _native;
    }
    _native = null;
    return null;
}

/**
 * Production-Ready Dependency Pre-Bundler
 * Uses full dependency graph bundling with splitting.
 * Handles transitive dependencies automatically.
 *
 * Phase 1.10: Cache root is driven by `cacheDir` from lunx.config
 * (default: `.lunx/cache`). SHA-256 fingerprints are stored in a native
 * SQLite DB via the prebundle N-API; the esbuild pass runs only on misses.
 */
export class DependencyPreBundler {
    /** Resolved absolute path to the pre-bundle output directory */
    public readonly cacheRoot: string;

    constructor(private root: string, cacheDirOrLegacy: string = 'node_modules/.lunx') {
        // Accept both old-style 'node_modules/.lunx' and new config-driven paths.
        // New config key (`cacheDir`) maps to '<root>/.lunx/cache' by default.
        // If the legacy default is still passed we keep backwards compat.
        this.cacheRoot = path.isAbsolute(cacheDirOrLegacy)
            ? cacheDirOrLegacy
            : path.join(root, cacheDirOrLegacy);
    }


    /**
     * Pre-bundle dependencies using full graph approach
     * This bundles ALL dependencies together with their transitive deps
     * Uses esbuild's splitting to create shared chunks
     */
    async preBundleDependencies(deps: string[]): Promise<Map<string, string>> {
        const bundledDeps = new Map<string, string>();
        const cacheDir = this.cacheRoot;

        // Ensure cache directory exists
        await fs.mkdir(cacheDir, { recursive: true });

        // ── Phase 1.10: Native SHA-256 fingerprint warm-start gate ──────────────
        // Build package metadata objects for native fingerprinting.
        // Each entry key = sha256(name + version + transitive dep versions).
        const native = getNative();
        if (native) {
            try {
                const pkgJsonRaw = await fs.readFile(path.join(this.root, 'package.json'), 'utf-8').catch(() => '{}');
                const pkgJsonParsed = JSON.parse(pkgJsonRaw);
                const pkgVersions: Record<string, string> = {
                    ...pkgJsonParsed.dependencies,
                    ...pkgJsonParsed.devDependencies,
                };

                const moduleMetas = deps.map(dep => {
                    const pkgName = dep.startsWith('@') ? dep.split('/').slice(0, 2).join('/') : dep.split('/')[0];
                    return { name: dep, version: pkgVersions[pkgName] || '0.0.0', deps: pkgVersions };
                });

                const nativeCfg = { cacheRoot: cacheDir };
                const results: Array<{ moduleId: string; key: string; bundle: string; hit: boolean }> =
                    native.prebundle(JSON.stringify(moduleMetas), nativeCfg);

                // All hits → serve from native SQLite cache, skip esbuild entirely
                const allHit = results.every(r => r.hit);
                if (allHit && results.length === deps.length) {
                    log.info('[lunx:prebundle] Warm start — serving all deps from native cache');
                    for (const r of results) {
                        const safeName = r.moduleId.replace(/[/@]/g, '_');
                        bundledDeps.set(r.moduleId, `/@lunx-deps/${safeName}.js`);
                    }
                    return bundledDeps;
                }
            } catch (e: any) {
                log.debug(`[lunx:prebundle] Native fingerprint check skipped: ${e.message}`);
            }
        }

        // Generate hash of package.json for cache invalidation (cross-platform crypto)
        const pkgJsonPath = path.join(this.root, 'package.json');
        const pkgJson = await fs.readFile(pkgJsonPath, 'utf-8');
        // 8-char hex — same width as old xxh64 slice
        const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);
        const hash = shortHash(pkgJson);
        const metaPath = path.join(cacheDir, '_metadata.json');

        // Check if cache is valid
        // Use both package.json hash AND a sorted dep list hash for strong cache invalidation
        const depsHash = shortHash([...deps].sort().join(','));
        let cachedMeta: any = {};
        try {
            cachedMeta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
            const cacheHit = cachedMeta.hash === hash &&
                (cachedMeta.depsHash === depsHash || // New-style: exact dep hash
                    (cachedMeta.deps && shortHash([...cachedMeta.deps].sort().join(',')) === depsHash)); // Legacy-style fallback
            if (cacheHit) {
                log.info('[lunx:prebundle] Using cached pre-bundled dependencies');
                // Load from cache
                for (const dep of deps) {
                    const cachedPath = cachedMeta.depMap?.[dep];
                    if (cachedPath) {
                        bundledDeps.set(dep, cachedPath);
                    }
                }
                if (bundledDeps.size === deps.length) {
                    return bundledDeps;
                }
            }
        } catch {
            // No cache or invalid, proceed with bundling
        }

        log.info('--> Pipeline: Pre-bundling dependencies...', { count: deps.length });

        const root = this.root;


        // Helper to check if file exists
        const fileExists = async (p: string) => {
            try {
                await fs.access(p);
                return true;
            } catch {
                return false;
            }
        };

        // Helper to find node_modules up the tree
        const findNodeModules = async (startDir: string, pkgName: string): Promise<string | undefined> => {
            let current = startDir;
            while (current !== path.parse(current).root) {
                const maybe = path.join(current, 'node_modules', pkgName);
                if (await fileExists(maybe)) return maybe;
                const parent = path.dirname(current);
                if (parent === current) break;
                current = parent;
            }
            return undefined;
        };

        // Framework-specific aliases: use the right build variant
        const DEP_ALIASES: Record<string, string> = {
            'vue': 'vue/dist/vue.esm-bundler.js',  // Includes template compiler for SFC
        };

        try {
            // Resolve all entry points
            const entryPoints: Record<string, string> = {};
            for (const dep of deps) {
                // Apply alias override if present
                const aliasedDep = DEP_ALIASES[dep] || dep;
                let resolvedPath: string | undefined;

                // Priority: Try to find package.json and use 'module' field (ESM)
                try {
                    // Find package root
                    const pkgName = aliasedDep.startsWith('@') ? aliasedDep.split('/').slice(0, 2).join('/') : aliasedDep.split('/')[0];

                    let pkgDir;
                    try {
                        const pkgJsonResolved = require.resolve(pkgName + '/package.json', { paths: [root] });
                        pkgDir = path.dirname(pkgJsonResolved);
                    } catch (e: any) {
                        // Manual search up the tree
                        pkgDir = await findNodeModules(root, pkgName);
                        // log.debug(`[PreBundler] JSON resolve failed for ${pkgName}, using fallback: ${pkgDir}`);
                    }

                    if (pkgDir) {
                        const pkgJsonPath = path.join(pkgDir, 'package.json');
                        try {
                            const pkgJsonRaw = await fs.readFile(pkgJsonPath, 'utf-8');
                            const pkgJson = JSON.parse(pkgJsonRaw);

                            // log.debug(`[PreBundler] Checked ${pkgName} package.json. Module: ${pkgJson.module}`);

                            // 1. Check 'exports' (Modern Node Resolution - Precedence over 'module')
                            if (pkgJson.exports) {
                                let exportKey = '.';
                                if (dep !== pkgName) {
                                    // Calculate subpath: preact/hooks -> ./hooks
                                    const subpath = './' + dep.substring(pkgName.length + 1);
                                    exportKey = subpath;
                                }

                                if (typeof pkgJson.exports === 'object') {
                                    const exportEntry = pkgJson.exports[exportKey];
                                    if (exportEntry) {
                                        // Handle nested conditions (browser > import > default > node > source)
                                        const resolveCondition = (entry: any): string | undefined => {
                                            if (typeof entry === 'string') return entry;
                                            if (typeof entry === 'object' && entry !== null) {
                                                return resolveCondition(entry.browser) ||
                                                    resolveCondition(entry.import) ||
                                                    resolveCondition(entry.default) ||
                                                    resolveCondition(entry.node) ||
                                                    resolveCondition(entry.source) ||
                                                    resolveCondition(entry.require);
                                            }
                                            return undefined;
                                        };

                                        const importPath = resolveCondition(exportEntry);
                                        if (importPath) {
                                            const candidate = path.join(pkgDir, importPath);
                                            if (await fileExists(candidate)) {
                                                resolvedPath = candidate;
                                                log.debug(`[PreBundler] Resolved via exports for ${dep}: ${resolvedPath}`);
                                            }
                                        }
                                    }
                                }
                            }

                            // 2. Fallback to 'module' or 'source' (only for main entry)
                            if (!resolvedPath && dep === pkgName) {
                                if (pkgJson.module && await fileExists(path.join(pkgDir, pkgJson.module))) {
                                    resolvedPath = path.join(pkgDir, pkgJson.module);
                                } else if (pkgJson.source && await fileExists(path.join(pkgDir, pkgJson.source))) {
                                    resolvedPath = path.join(pkgDir, pkgJson.source);
                                    log.debug(`[PreBundler] Using 'source' field for ${dep}: ${resolvedPath}`);
                                } else if (pkgJson.main && await fileExists(path.join(pkgDir, pkgJson.main))) {
                                    resolvedPath = path.join(pkgDir, pkgJson.main);
                                }
                            }
                        } catch (e: any) {
                            log.warn(`[PreBundler] Failed to read/parse package.json for ${pkgName}: ${e.message}`);
                        }
                    }
                } catch (e: any) {
                    log.warn(`[PreBundler] ESM resolution error for ${dep}: ${e.message}`);
                }

                // Try direct alias path (e.g. vue/dist/vue.esm-bundler.js)
                if (!resolvedPath && aliasedDep !== dep) {
                    try {
                        const cand = require.resolve(aliasedDep, { paths: [root] });
                        if (await fileExists(cand)) {
                            resolvedPath = cand;
                            log.debug(`[PreBundler] Aliased ${dep} → ${aliasedDep}: ${resolvedPath}`);
                        }
                    } catch { }
                }

                // Fallback to require.resolve (Standard Node Resolution)
                if (!resolvedPath) {
                    try {
                        const cand = require.resolve(aliasedDep !== dep ? aliasedDep : dep, { paths: [root] });
                        if (await fileExists(cand)) {
                            resolvedPath = cand;
                        }
                    } catch (e) {
                        try {
                            const maybeDirect = path.join(root, 'node_modules', dep);
                            if (await fileExists(maybeDirect)) resolvedPath = maybeDirect;
                        } catch { }
                    }
                }

                if (resolvedPath) {
                    // ... verify existence ...
                    const normalizedName = dep.replace(/[/@]/g, '_');
                    entryPoints[normalizedName] = resolvedPath;
                    log.debug(`[PreBundler] Resolved ${dep} → ${resolvedPath}`);
                } else {
                    log.warn(`[PreBundler] Could not resolve ${dep}`);
                }
            }

            if (Object.keys(entryPoints).length === 0) {
                log.warn('[PreBundler] No dependencies to bundle');
                return bundledDeps;
            }

            // Production-ready: Full graph bundling WITH splitting + CJS export fix
            const result = await build({
                entryPoints,
                bundle: true,
                format: 'esm',
                platform: 'browser',
                target: 'es2020',
                outdir: cacheDir,
                splitting: true,  // PRODUCTION: Shared chunks for efficiency
                chunkNames: 'chunks/[name]-[hash]',
                entryNames: '[name]',
                minify: false,
                sourcemap: true,
                treeShaking: true,
                define: {
                    'process.env.NODE_ENV': '"development"',
                    'global': 'globalThis'
                },
                plugins: [
                    // Plugin to fix CJS → ESM named exports
                    {
                        name: 'cjs-esm-interop',
                        setup(build) {
                            // Post-process: Add named exports to entry point files
                            build.onEnd(async (result) => {
                                if (result.metafile) {
                                    for (const [outputPath, outputInfo] of Object.entries(result.metafile.outputs)) {
                                        // Only process entry points (not chunks)
                                        if (outputInfo.entryPoint) {
                                            const fullPath = path.resolve(outputPath);
                                            let content = await fs.readFile(fullPath, 'utf-8');

                                            // Check if it's a thin wrapper (only imports from chunks)
                                            if (content.includes('from "./chunks/') && !content.includes('export {')) {
                                                // Find which original package this is
                                                const basename = path.basename(outputPath, '.js');
                                                for (const dep of deps) {
                                                    const normalizedName = dep.replace(/[/@]/g, '_');
                                                    if (basename === normalizedName) {
                                                        try {
                                                            // Load the original CJS module to get exports
                                                            let pkg;
                                                            try {
                                                                const pkgPath = require.resolve(dep, { paths: [root] });
                                                                pkg = require(pkgPath);
                                                            } catch (e) {
                                                                // If require fails (e.g. ESM package), try to find common names or skip
                                                                log.debug(`[PreBundler] Skipped CJS re-export for ${dep} (ESM or missing)`);
                                                                continue;
                                                            }

                                                            if (!pkg) continue;

                                                            // Get all named exports
                                                            const exportNames = Object.getOwnPropertyNames(pkg)
                                                                .filter(key =>
                                                                    /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) &&
                                                                    key !== 'default' &&
                                                                    key !== '__esModule'
                                                                );

                                                            // Add re-exports if needed
                                                            if (exportNames.length > 0 && !content.includes('export const')) {
                                                                const defaultExportMatch = content.match(/export default (\w+)(?:\(\))?;?/);
                                                                if (defaultExportMatch) {
                                                                    const varName = defaultExportMatch[1];
                                                                    const isFunctionCall = content.includes(`export default ${varName}()`);

                                                                    let exportBase = varName;

                                                                    if (isFunctionCall) {
                                                                        // Replace "export default foo();" with "const __pkg = foo(); export default __pkg;"
                                                                        content = content.replace(
                                                                            `export default ${varName}();`,
                                                                            `const __pkg = ${varName}();\nexport default __pkg;`
                                                                        );
                                                                        exportBase = '__pkg';
                                                                    }

                                                                    const namedExports = exportNames.map(name =>
                                                                        `export const ${name} = ${exportBase}.${name};`
                                                                    ).join('\n');

                                                                    content = content.replace(
                                                                        /\/\/# sourceMappingURL=/,
                                                                        `${namedExports}\n//# sourceMappingURL=`
                                                                    );

                                                                    await fs.writeFile(fullPath, content);
                                                                    log.debug(`[PreBundler] Added ${exportNames.length} named exports to ${dep}`);
                                                                }
                                                            }
                                                        } catch (e: any) {
                                                            log.warn(`[PreBundler] Could not add exports for ${dep}: ${e.message}`);
                                                        }
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            });
                        }
                    }
                ],
                logLevel: 'warning',
                metafile: true,
            });

            // Build dependency map from output files
            const depMap: Record<string, string> = {};

            if (result.metafile) {
                const outputs = result.metafile.outputs;

                // Map entry points to their output files
                for (const [outputPath, outputInfo] of Object.entries(outputs)) {
                    if (outputInfo.entryPoint) {
                        // Match output file to original dependency by exact normalized name
                        const outputBasename = path.basename(outputPath, '.js');

                        for (const dep of deps) {
                            const normalizedName = dep.replace(/[/@]/g, '_');
                            // Exact match - prevent "react" matching "react-router-dom"
                            if (outputBasename === normalizedName) {
                                const relativePath = path.relative(cacheDir, outputPath);
                                const urlPath = `/@lunx-deps/${relativePath}`;
                                bundledDeps.set(dep, urlPath);
                                depMap[dep] = urlPath;
                                log.debug(`✓ Pre-bundled: ${dep} → ${urlPath}`);
                                break;
                            }
                        }
                    }
                }
            }

            // Save metadata
            await fs.writeFile(metaPath, JSON.stringify({
                hash,
                depsHash,
                deps: Array.from(bundledDeps.keys()),
                depMap,
                timestamp: Date.now()
            }, null, 2));

            // Phase 1.10: persist bundles into native SQLite for future warm starts
            const nativeForPut = getNative();
            if (nativeForPut) {
                try {
                    const pkgJsonRaw = await fs.readFile(path.join(this.root, 'package.json'), 'utf-8').catch(() => '{}');
                    const pkgJsonParsed = JSON.parse(pkgJsonRaw);
                    const pkgVersions: Record<string, string> = {
                        ...pkgJsonParsed.dependencies,
                        ...pkgJsonParsed.devDependencies,
                    };
                    const nativeCfg = { cacheRoot: cacheDir };
                    for (const dep of bundledDeps.keys()) {
                        const pkgName = dep.startsWith('@') ? dep.split('/').slice(0, 2).join('/') : dep.split('/')[0];
                        const meta = { name: dep, version: pkgVersions[pkgName] || '0.0.0', deps: pkgVersions };
                        const fingerResults = nativeForPut.prebundle(JSON.stringify([meta]), nativeCfg);
                        if (fingerResults.length > 0 && !fingerResults[0].hit) {
                            const safeName = dep.replace(/[/@]/g, '_');
                            const outFile = path.join(cacheDir, `${safeName}.js`);
                            const content = await fs.readFile(outFile, 'utf-8').catch(() => `/* ${dep} */`);
                            nativeForPut.prebundlePut(fingerResults[0].key, dep, content, nativeCfg);
                        }
                    }
                } catch (e: any) {
                    log.debug(`[lunx:prebundle] Native persist skipped: ${e.message}`);
                }
            }

            log.info(`✓ Pre-bundled ${bundledDeps.size} dependencies`);
            return bundledDeps;

        } catch (error: any) {
            log.error('Pre-bundling failed:', error.message);
            log.error(error.stack);
            return bundledDeps;
        }
    }

    async scanDependencies(entryFile: string): Promise<string[]> {
        const content = await fs.readFile(entryFile, 'utf-8');
        const deps = new Set<string>();

        // Simple regex-based scan for imports
        const importRegex = /from\s+['"]([^.\/][^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
            const dep = match[1];
            // Extract package name (handle scoped packages)
            const pkgName = dep.startsWith('@')
                ? dep.split('/').slice(0, 2).join('/')
                : dep.split('/')[0];
            deps.add(pkgName);
        }

        return Array.from(deps);
    }
}
