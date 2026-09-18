
/**
 * Engine Execution Stage - Optimized (v2.0.2 World Domination)
 */

import { BuildContext, BuildPlan, BuildArtifact, ExecutionPlan } from './types.js';
import { explainReporter } from './events.js';
import { canonicalHash } from './hash.js';
import fs from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
import { generateModuleId, normalizePath } from '../../resolve/utils.js';
import { Transformer } from '../transform/transformer.js';
import { GlobalOptimizer } from '../build/globalOptimizer.js';
import { ShortIdMap } from '../graph/serializer.js';

// Phase 3.1 + 3.2 — Native chunker + source map merger
let _native: any = null;
async function getNative() {
    if (_native) return _native;
    try { _native = await import('../../native/index.js'); } catch { _native = {}; }
    return _native;
}

export async function executeParallel(execPlan: ExecutionPlan, buildPlan: BuildPlan, ctx: BuildContext): Promise<BuildArtifact[]> {
    explainReporter.report('execute', 'start', 'Starting optimized execution');

    const artifacts: BuildArtifact[] = [];
    const artifactMap = new Map<string, BuildArtifact>();
    const isProd = ctx.mode === 'production' || ctx.mode === 'build';

    // Phase 2: Short Stable IDs (Persist across chunks for consistency)
    const federationName = ctx.config.federation?.name;
    const shortIdPrefix = federationName ? `${federationName}_n` : 'n';
    const shortIdMap = new ShortIdMap(shortIdPrefix);
    const globalOptimizer = new GlobalOptimizer();

    for (const group of execPlan.parallelGroups) {
        const tasks = group.map(async (chunkId) => {
            const chunk = buildPlan.chunks.find(c => c.id === chunkId);
            if (!chunk) return;

            const pipelineHash = ctx.pluginManager.getPipelineHash();
            const moduleHashes: Record<string, string> = {};
            for (const modId of chunk.modules) {
                const node = ctx.graph.nodes.get(modId);
                if (node) moduleHashes[modId] = node.contentHash;
            }

            const chunkKey = canonicalHash({
                id: chunk.id,
                moduleHashes,
                configHash: canonicalHash(ctx.config),
                pipelineHash,
                mode: ctx.mode
            });

            // CACHE CHECK
            const cached = await ctx.cache.get(chunkKey);
            if (cached) {
                artifactMap.set(chunk.id, cached.artifact);
                return;
            }

            let bundleContent = '';
            const isCss = chunk.id.endsWith('_css');

            // Phase 1: ULTRA-CONDENSED RUNTIME (Globally Shared for Module Federation)
            if (!isCss) {
                // process shim: React and many libs check process.env.NODE_ENV at runtime
                const processShim = `if(typeof process==="undefined"){globalThis.process={env:{NODE_ENV:"production"}}}\n`;
                const rt = `(function(g){g.__nm=g.__nm||{};if(!g.d)g.d=(i,f)=>g.__nm[i]=f;if(!g.r)g.r=i=>{if(!g.__nm[i])throw new Error("Module not found: "+i);if(g.__nm[i].z)return g.__nm[i].z;const o={exports:{}};g.__nm[i](o,o.exports,g.r);return g.__nm[i].z=o.exports}})(globalThis);\n`;
                let fedRt = '';
                if (ctx.config.federation && ctx.config.federation.remotes) {
                    const remotes = ctx.config.federation.remotes as Record<string, string>;
                    const remotesMap = JSON.stringify(Object.fromEntries(
                      Object.entries(remotes).map(([name, url]) => {
                        const normalizedUrl = (typeof url === 'string' ? url : String(url)).replace(/^([A-Za-z0-9_$-]+)@(https?:\/\/.*)$/, '$2');
                        return [name, normalizedUrl];
                      })
                    ));
                    fedRt = `globalThis.__remotes=${remotesMap};globalThis.__loadRemote=async function(r,m){var u=__remotes[r];if(!window[r]){await new Promise((rs,rj)=>{var s=document.createElement('script');s.type='module';s.crossOrigin='anonymous';s.async=true;s.src=u;s.onload=rs;s.onerror=rj;document.head.appendChild(s)})}var c=window[r];await c.init({});var f=await c.get(m);return f();};\n`;
                }
                bundleContent += isProd ? processShim + rt + fedRt : `/* Lunx Runtime */\n${processShim}${rt}${fedRt}`;
            }

            const artifactModules: any[] = [];
            const transformer = new Transformer();
            const moduleResults = new Map<string, { code: string, originalSize: number }>();
            const pendingTransform: any[] = [];

            // Parallel Load (Respecting Plugins)
            await Promise.all(chunk.modules.map(async (modId) => {
                const node = ctx.graph.nodes.get(modId);
                const path = node?.path || modId;

                // Try Plugin LOAD hook first (for assets, etc.)
                const loadResult = await ctx.pluginManager.runHook('load', { id: modId, path }, ctx);

                let content: string;
                if (loadResult && loadResult.code !== undefined) {
                    content = loadResult.code;
                } else {
                    content = await fs.readFile(path, 'utf-8');
                }

                pendingTransform.push({ id: modId, path, content });
            }));

            // Phase 3: NATIVE BATCH (SWC Fix applied in transform.rs)
            if (pendingTransform.length > 0) {
                const batchResults = await transformer.batchTransform(pendingTransform, ctx);
                for (const res of batchResults) {
                    const p = pendingTransform.find(x => x.id === res.id);
                    moduleResults.set(res.id, { code: res.code, originalSize: Buffer.byteLength(p.content) });
                }
            }

            // Phase 3.1 — Native DCE via lunxChunk (production only, additive — falls back to existing logic)
            if (isProd && moduleResults.size > 0) {
                try {
                    const nat = await getNative();
                    if (nat.lunxChunk) {
                        const graphJson = JSON.stringify({
                            modules: [...moduleResults.keys()].map(id => {
                                const node = ctx.graph.nodes.get(id);
                                return {
                                    id,
                                    imports: [...(node?.edges?.map(e => e.to) ?? [])],
                                    exports: [],
                                    sizeBytes: moduleResults.get(id)!.code.length
                                };
                            })
                        });
                        let resolvedEntryPoint = chunk.entry;
                        if (chunk.entry) {
                            const absEntry = path.isAbsolute(chunk.entry) ? chunk.entry : path.resolve(ctx.rootDir, chunk.entry);
                            resolvedEntryPoint = generateModuleId('file', normalizePath(absEntry), ctx.rootDir);
                        }
                        
                        const result = nat.lunxChunk(graphJson, {
                            strategy: 'auto',
                            maxChunkSizeKb: 0,
                            entryPoints: resolvedEntryPoint && moduleResults.has(resolvedEntryPoint) 
                                ? [resolvedEntryPoint] 
                                : [...moduleResults.keys()].slice(0, 1)
                        });
                        if (result.eliminated?.length > 0) {
                            for (const id of result.eliminated) moduleResults.delete(id);
                            explainReporter.report('execute', 'dce', `Native DCE eliminated ${result.eliminated.length} modules`);
                        }
                    }
                } catch (e: any) {
                    // Native DCE unavailable — existing JS tree-shake handles it
                }
            }

            // Phase 3.5 (existing): TREE SHAKING (Production Only - Before Bundling)
            if (isProd && moduleResults.size > 0) {
                const { AutoFixEngine } = await import('../../fix/ast-transforms.js');
                const autoFix = new AutoFixEngine();

                // Collect modules with REAL paths from dependency graph
                const modulesForShaking = new Map<string, string>();
                const idToPath = new Map<string, string>();

                for (const [modId, result] of moduleResults) {
                    // Get actual file path from graph
                    const node = ctx.graph.nodes.get(modId);
                    if (node && node.path) {
                        modulesForShaking.set(node.path, result.code);
                        idToPath.set(modId, node.path);
                    }
                }

                if (modulesForShaking.size > 0) {
                    // Perform tree shaking with real paths
                    const shakenResults = autoFix.treeShake(modulesForShaking);

                    // Apply shaken code back to moduleResults using ID mapping
                    for (const [modId, result] of moduleResults) {
                        const realPath = idToPath.get(modId);
                        if (realPath) {
                            const shakenResult = shakenResults.get(realPath);
                            if (shakenResult?.success && shakenResult.code) {
                                const savings = result.code.length - shakenResult.code.length;
                                if (savings > 0) {
                                    moduleResults.set(modId, {
                                        code: shakenResult.code,
                                        originalSize: result.originalSize
                                    });
                                    explainReporter.report('execute', 'tree-shake',
                                        `${realPath}: Removed ${shakenResult.changes.length} unused exports, saved ${savings} bytes`);
                                }
                            }
                        }
                    }
                }
            }

            // Phase 2: Assemble with Short IDs
            for (const modId of chunk.modules) {
                const res = moduleResults.get(modId);
                if (!res) continue;

                const node = ctx.graph.nodes.get(modId);
                const shortId = shortIdMap.get(modId, isProd);
                artifactModules.push({ 
                    id: modId, 
                    shortId, 
                    size: res.code.length, 
                    originalSize: res.originalSize,
                    path: node?.path || modId
                });

                if (isCss) {
                    bundleContent += `\n/* ${modId} */\n${res.code}`;
                } else {
                    let moduleCode = res.code;

                    // SWC compiles to CommonJS, so all imports are already `require("hash16chars")`.
                    // We must map these 16-char hashes to our short IDs.
                    moduleCode = moduleCode.replace(
                        /\brequire\s*\(\s*["']([a-f0-9]{16})["']\s*\)/g,
                        (match, hash) => {
                            const targetId = shortIdMap.get(hash, isProd) || hash;
                            return `require("${targetId}")`;
                        }
                    );

                    // Map ALL require() calls (relative, bare, scoped) to registered short IDs.
                    // Uses specifierMap from graph for known deps, and falls back to runtime
                    // require.resolve for SWC-injected specifiers like 'react/jsx-runtime'.
                    const graphNode = ctx.graph.nodes.get(modId);
                    const specMap = graphNode?.specifierMap || {};
                    const moduleDirPath = graphNode?.path ? path.dirname(graphNode.path) : ctx.rootDir;

                    // Step 1: Resolve relative requires via specMap
                    moduleCode = moduleCode.replace(
                        /\brequire\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
                        (match, relPath) => {
                            const depId = specMap[relPath];
                            if (depId) {
                                return `require("${shortIdMap.get(depId, isProd) || depId}")`;
                            }
                            return match;
                        }
                    );

                    // Step 2: Resolve bare/scoped specifiers via specMap first, then Node resolve
                    moduleCode = moduleCode.replace(
                        /\brequire\s*\(\s*["'](@?(?:[a-zA-Z@][^"'\.\s][^"']*|[a-zA-Z][^"'\s/][^"']*\/[^"']+))["']\s*\)/g,
                        (match, specifier) => {
                            // Try specifierMap first
                            const depId = specMap[specifier];
                            if (depId) {
                                return `require("${shortIdMap.get(depId, isProd) || depId}")`;
                            }
                            // Fall back: resolve via Node and look up in graph
                            try {
                                const resolved = _require.resolve(specifier, { paths: [moduleDirPath, ctx.rootDir] });
                                const normalized = normalizePath(resolved);
                                const resolvedId = generateModuleId('file', normalized, ctx.rootDir);
                                const shortId2 = shortIdMap.get(resolvedId, isProd);
                                // Only replace if the module is actually in our bundle
                                if (ctx.graph.nodes.has(resolvedId)) {
                                    return `require("${shortId2 || resolvedId}")`;
                                }
                            } catch (_) { /* ignore unresolvable */ }
                            return match;
                        }
                    );

                    // Step 3: Map SWC dynamic imports of federated remotes to window.__loadRemote
                    if (ctx.config.federation && ctx.config.federation.remotes) {
                        const remoteNames = Object.keys(ctx.config.federation.remotes).join('|');
                        if (remoteNames) {
                            const dynImportRegex = new RegExp(`\\bimport\\s*\\(\\s*["'](${remoteNames})\\/([^"']+)["']\\s*\\)`, 'g');
                            moduleCode = moduleCode.replace(dynImportRegex, (match, remote, mod) => {
                                return `globalThis.__loadRemote("${remote}", "./${mod}")`;
                            });
                        }
                    }

                    // Always use 'globalThis.d' as defined in condensed runtime
                    bundleContent += `\nglobalThis.d("${shortId}",function(module,exports,require,h){\n${moduleCode}\n});`;
                }
            }

            // Entry Execution
            if (!isCss && chunk.entry) {
                const absEntry = path.isAbsolute(chunk.entry)
                    ? chunk.entry
                    : path.resolve(ctx.rootDir, chunk.entry);
                const entryId = generateModuleId('file', normalizePath(absEntry), ctx.rootDir);
                const shortEntryId = shortIdMap.get(entryId, isProd);
                bundleContent += `\n\nglobalThis.r("${shortEntryId}");`;
            }

            const artifact: BuildArtifact = {
                id: canonicalHash(bundleContent).substring(0, 16),
                type: isCss ? 'css' : 'js',
                fileName: chunk.outputName,
                entry: chunk.entry,
                dependencies: [...chunk.modules],
                source: bundleContent,
                modules: artifactModules
            };

            // Generate source map if enabled
            if (!isCss && ctx.config.sourceMaps) {
                // Phase 3.2 — Try native mergeSourceMaps to compose SWC + LightningCSS maps
                let sourceMapJson = '';
                try {
                    const nat = await getNative();
                    if (nat.mergeSourceMaps) {
                        // Collect individual per-module maps emitted during transform
                        const perModuleMaps = [...chunk.modules]
                            .map(id => (moduleResults.get(id) as any)?.map)
                            .filter(Boolean) as string[];
                        if (perModuleMaps.length > 0) {
                            sourceMapJson = nat.mergeSourceMaps(perModuleMaps);
                        }
                    }
                } catch { /* fallback to hand-made map below */ }

                if (!sourceMapJson) {
                    // Fallback: hand-made skeleton map (same as before)
                    const sourceMapContent = {
                        version: 3,
                        sources: chunk.modules.map(modId => {
                            const node = ctx.graph.nodes.get(modId);
                            return node?.path || modId;
                        }),
                        names: [],
                        mappings: '',
                        file: chunk.outputName
                    };
                    sourceMapJson = JSON.stringify(sourceMapContent);
                }
                if (ctx.config.sourceMaps === 'inline') {
                    // Inline source map
                    artifact.source += `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(sourceMapJson).toString('base64')}`;
                } else if (ctx.config.sourceMaps === 'external' || ctx.config.sourceMaps === true) {
                    // External source map file
                    const mapFileName = chunk.outputName + '.map';
                    artifact.source += `\n//# sourceMappingURL=${mapFileName}`;

                    // Create separate map artifact
                    const mapArtifact: BuildArtifact = {
                        id: canonicalHash(sourceMapJson).substring(0, 16),
                        type: 'map',
                        fileName: mapFileName,
                        dependencies: [],
                        source: sourceMapJson
                    };
                    artifactMap.set(chunk.id + '_map', mapArtifact);
                }
                // 'hidden' mode: generate map but don't add reference
            }

            ctx.cache.set(chunkKey, { hash: chunkKey, artifact });
            artifactMap.set(chunk.id, artifact);
        });

        await Promise.all(tasks);
    }

    // Process Final Order
    for (const id of buildPlan.executionOrder) {
        const art = artifactMap.get(id);
        if (art) artifacts.push(art);
    }

    // Phase 1: GLOBAL NATIVE MINIFICATION
    if (isProd) {
        await globalOptimizer.optimize(artifacts);
    }

    // Assets
    for (const asset of buildPlan.assets) {
        const node = ctx.graph.nodes.get(asset.id);
        if (node) {
            artifacts.push({
                id: node.contentHash,
                type: 'asset' as any,
                fileName: asset.outputName,
                dependencies: [],
                source: await fs.readFile(node.path)
            });
        }
    }

    return artifacts;
}
