
import { loadConfig } from '../config/index.js';
import { CoreBuildEngine } from '../core/engine/index.js';
import { log } from '../utils/logger.js';
import path from 'path';

export async function inspectProject(filter?: string) {
    try {
        const cwd = process.cwd();
        const config = await loadConfig(cwd);
        const engine = new CoreBuildEngine();

        // Run specific engine steps to get the graph
        // (We can't easily jump to just graph building via public API, 
        //  but the engine caches the graph. We can run a dummy "dev" build or 
        //  better, expose a `buildGraph` method on the engine or just use internal methods if possible.
        //  Looking at `src/core/engine/index.ts`, `run` does everything.
        //  Ideally we refactor engine to expose `buildGraph` publicly, 
        //  but for now we can instantiate the graph manually or use a dry-run mode if we add one.)

        // Actually, let's use the public API but maybe catch the result?
        // Or better, since this is "Phase H - Official Surface Area Maintenance", 
        // we should EXPOSE `buildGraph` in the engine.
        log.info('Inspecting dependency graph...');

        const { buildDependencyGraph } = await import('../resolve/build-graph.js');
        const graph = await buildDependencyGraph(config, cwd);

        // Display Graph
        const nodes = Array.from(graph.nodes.values());

        console.log(`\n📦 Graph Summary:`);
        console.log(`   Total Modules: ${nodes.length}`);
        console.log(`   Entry Points:  ${config.entry.join(', ')}`);

        if (filter) {
            console.log(`\n🔍 Filtering by: "${filter}"`);
            const filtered = nodes.filter(n => n.id.includes(filter) || n.path.includes(filter));
            filtered.forEach(n => printNode(n));
        } else {
            console.log(`\n📄 All Modules:`);
            // Limit output if too large
            if (nodes.length > 20) {
                const first10 = nodes.slice(0, 10);
                const last10 = nodes.slice(-10);
                first10.forEach(n => printNode(n));
                console.log(`   ... (${nodes.length - 20} more) ...`);
                last10.forEach(n => printNode(n));
            } else {
                nodes.forEach(n => printNode(n));
            }
        }

        // Validate
        const validation = graph.validate();
        if (!validation.isValid) {
            console.log(`\n⚠️  Graph Issues Found:`);
            if (validation.cycles.length > 0) {
                console.log(`   - Circular Dependencies detected: ${validation.cycles.length}`);
                validation.cycles.forEach(c => console.log(`     Cycle: ${c.join(' -> ')}`));
            }
        } else {
            console.log(`\n✅ Graph is valid (no cycles).`);
        }

    } catch (e: any) {
        log.error(`Inspection failed: ${e.message}`);
        process.exit(1);
    }
}

function printNode(node: any) {
    const deps = node.edges.length;
    console.log(` - [${node.type}] ${path.relative(process.cwd(), node.path)} (${deps} deps)`);
}
