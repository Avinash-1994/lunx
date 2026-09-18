
/**
 * Engine Build Planning
 * 
 * @internal - This is part of the core engine and NOT a public API.
 */

import { BuildContext, BuildPlan, ChunkPlan, AssetPlan, ExecutionPlan, BuildMode } from './types.js';
import { explainReporter } from './events.js';
import { canonicalHash } from './hash.js';
import path from 'path';

import { normalizePath, generateModuleId } from '../../resolve/utils.js';

// Stage 4: Build Planning
export function planBuild(ctx: BuildContext): BuildPlan {
    explainReporter.report('plan', 'start', 'Starting build planning');

    const chunks: ChunkPlan[] = [];
    const assets: AssetPlan[] = [];
    const entryDeps = new Map<string, Set<string>>();

    const sortedEntries = [...ctx.config.entryPoints]
        .filter((entry) => !entry.toLowerCase().split(/[?#]/)[0].endsWith('.html'))
        .sort();
    const getId = (p: string) => {
        const normalized = normalizePath(p);
        return generateModuleId('file', normalized, ctx.rootDir);
    };

    // 1. Identify Async Entry Points (targets of dynamic imports)
    const asyncEntries = new Set<string>();
    for (const node of ctx.graph.nodes.values()) {
        for (const edge of node.edges) {
            if (edge.kind === 'dynamic-import') {
                asyncEntries.add(edge.to);
            }
        }
    }

    // 2. Traversal Helper (stops at async boundaries)
    const traverse = (startId: string) => {
        const visited = new Set<string>();
        const queue = [startId];
        while (queue.length > 0) {
            const currId = queue.shift()!;
            if (visited.has(currId)) continue;
            visited.add(currId);

            const node = ctx.graph.nodes.get(currId);
            if (node) {
                const sortedDeps = node.edges
                    .filter(e => e.kind !== 'dynamic-import') // Stop at dynamic boundaries
                    .map(e => e.to)
                    .sort();
                for (const dep of sortedDeps) {
                    if (!asyncEntries.has(dep)) { // Don't follow into other async entries
                        queue.push(dep);
                    }
                }
            }
        }
        return visited;
    };

    // 3. Process Main Entries
    const mainEntries = sortedEntries.map(e => getId(path.resolve(ctx.rootDir, e)));

    // PRODUCTION TREE-SHAKING: Use native graph analysis to prune unreachable modules
    let reachableModules: Set<string> | null = null;
    if ((ctx.config as any).build?.treeShaking !== false && (ctx.mode === 'production' || ctx.mode === 'build')) {
        try {
            const entryIds = mainEntries.filter(id => ctx.graph.nodes.has(id));
            if (entryIds.length > 0) {
                const reachable = ctx.graph.getReachableNodes(entryIds);
                reachableModules = new Set(reachable);
                const totalNodes = ctx.graph.nodes.size;
                const pruned = totalNodes - reachable.length;
                if (pruned > 0) {
                    explainReporter.report('plan', 'tree_shake', `Native tree-shaking: Pruned ${pruned}/${totalNodes} unreachable modules`);
                }
            }
        } catch (e) {
            explainReporter.report('plan', 'tree_shake_fallback', 'Native tree-shaking unavailable, using all modules');
        }
    }

    for (const entryId of mainEntries) {
        if (!ctx.graph.nodes.has(entryId)) continue;
        const deps = traverse(entryId);

        // Filter to only reachable modules if tree-shaking was successful
        const finalDeps = reachableModules
            ? new Set([...deps].filter(id => reachableModules!.has(id)))
            : deps;

        entryDeps.set(ctx.graph.nodes.get(entryId)!.path, finalDeps);
    }

    // 4. Process Async Entries
    for (const entryId of Array.from(asyncEntries).sort()) {
        const deps = traverse(entryId);

        // Filter to only reachable modules if tree-shaking was successful
        const finalDeps = reachableModules
            ? new Set([...deps].filter(id => reachableModules!.has(id)))
            : deps;

        entryDeps.set(ctx.graph.nodes.get(entryId)!.path, finalDeps);
    }

    // 5. Create Chunks
    const sortedEntryKeys = Array.from(entryDeps.keys()).sort();
    for (const entry of sortedEntryKeys) {
        const deps = entryDeps.get(entry)!;
        const allModules = Array.from(deps).sort();

        const jsModules = allModules.filter(id => {
            const type = ctx.graph.nodes.get(id)?.type;
            return type === 'file' || type === 'style-asset';
        });
        const cssModules = allModules.filter(id => {
            const type = ctx.graph.nodes.get(id)?.type;
            return type === 'css' || type === 'css-module';
        });
        const assetModules = allModules.filter(id => ctx.graph.nodes.get(id)?.type === 'style-asset');

        const isAsync = asyncEntries.has(getId(entry));
        const name = path.basename(entry, path.extname(entry));
        const outputPrefix = isAsync ? `chunk.${name}` : name;

        if (jsModules.length > 0) {
            chunks.push({
                id: `chunk_${name}_js`,
                entry: path.relative(ctx.rootDir, entry),
                modules: jsModules,
                outputName: `assets/${outputPrefix}.${canonicalHash(jsModules).substring(0, 8)}.bundle.js`
            });
        }

        if (cssModules.length > 0) {
            chunks.push({
                id: `chunk_${name}_css`,
                entry: path.relative(ctx.rootDir, entry),
                modules: cssModules,
                outputName: `assets/${outputPrefix}.${canonicalHash(cssModules).substring(0, 8)}.bundle.css`
            });
        }

        for (const assetId of assetModules) {
            const node = ctx.graph.nodes.get(assetId);
            if (node) {
                assets.push({
                    id: assetId,
                    sourcePath: path.relative(ctx.rootDir, node.path),
                    outputName: `assets/${path.basename(node.path)}`
                });
            }
        }
    }

    // Sort chunks strictly by ID
    chunks.sort((a, b) => a.id.localeCompare(b.id));

    const executionOrder = chunks.map(c => c.id);

    // Calculate Plan ID (Hash of the plan content)
    const planStructure = {
        target: ctx.target,
        chunks,
        assets,
        executionOrder
    };
    const planId = canonicalHash(planStructure);

    explainReporter.report('plan', 'complete', 'Build plan created', { planId, chunkCount: chunks.length });

    return {
        planId,
        target: ctx.target,
        chunks,
        assets,
        executionOrder
    };
}

// Stage 5: Parallel Execution Planning
export function planParallelExecution(plan: BuildPlan): ExecutionPlan {
    explainReporter.report('parallel_plan', 'start', 'Planning parallel execution');

    // For this simple engine, chunks are independent enough to run in parallel
    // In a real complex graph, we'd analyze shared chunks to avoid race conditions 
    // or build shared dependencies first.
    // Here we treat all chunks as one parallel group.

    const chunkIds = plan.chunks.map(c => c.id);

    const execPlan: ExecutionPlan = {
        sequential: [], // setup steps if any
        parallelGroups: [chunkIds] // All chunks in one parallel wave
    };

    explainReporter.report('parallel_plan', 'complete', 'Execution plan ready', { groups: execPlan.parallelGroups.length });
    return execPlan;
}

// Stage 6: Determinism Check
export function determinismCheck(plan: BuildPlan, ctx: BuildContext): void {
    explainReporter.report('determinism', 'check', `Checking determinism for mode: ${ctx.mode}`);

    // 1. Check Module Sorting
    // All chunk modules must be sorted.
    for (const chunk of plan.chunks) {
        const sorted = [...chunk.modules].sort();
        if (JSON.stringify(chunk.modules) !== JSON.stringify(sorted)) {
            const msg = `Determinism Violation: Chunk ${chunk.id} modules are not sorted.`;
            if (ctx.mode === 'ci') throw new Error(msg);
            explainReporter.report('determinism', 'fail', msg);
        }
    }

    // 2. Check Execution Order matches Chunks
    const planIds = plan.chunks.map(c => c.id);
    if (JSON.stringify(planIds) !== JSON.stringify(plan.executionOrder)) {
        const msg = `Determinism Violation: Execution order does not match chunk sort order.`;
        if (ctx.mode === 'ci') throw new Error(msg);
        explainReporter.report('determinism', 'fail', msg);
    }

    explainReporter.report('determinism', 'pass', 'Determinism checks passed');
}
