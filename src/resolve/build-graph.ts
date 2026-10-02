/**
 * Builds a dependency graph for a project without running a build.
 *
 * The engine only populates its graph during `build()`, and it keeps it in
 * memory, so commands that merely want to *look* at the graph had no way to
 * get one: `lunx why` printed "No dependency graph — run lunx build first",
 * advice that cannot work because the next process starts with an empty
 * engine. `lunx inspect` worked around it by reimplementing this inline, with
 * a comment admitting the duplication. This is that logic, once.
 */

import path from 'path';
import type { BuildConfig } from '../config/index.js';
import type { DependencyGraph } from './graph.js';

export interface ResolvedProjectGraph {
    graph: DependencyGraph;
    /** Graph node ids for the entries, which is where a traversal starts. */
    entryIds: string[];
}

/** Graph plus its entry node ids, for commands that walk from the entries. */
export async function resolveProjectGraph(
    config: BuildConfig,
    cwd: string = process.cwd(),
): Promise<ResolvedProjectGraph> {
    const graph = await buildDependencyGraph(config, cwd);
    const root = config.root || cwd;
    // `config.entry` holds source paths (often index.html); a traversal needs
    // the ids the graph actually keyed its nodes under.
    const entryIds = Array.from(graph.nodes.values())
        .filter((node) => (node as { isEntry?: boolean }).isEntry)
        .map((node) => node.id);

    if (entryIds.length > 0) return { graph, entryIds };

    // No explicit entry flag: fall back to matching the expanded entry paths.
    const { expandHtmlEntries } = await import('../build/html-entry.js');
    const rawEntries = Array.isArray(config.entry)
        ? config.entry
        : config.entry
            ? [config.entry]
            : [];
    const { entryPoints } = expandHtmlEntries(rawEntries, root);
    // The graph stores paths with a lowercased drive letter on Windows, so the
    // comparison has to be case-insensitive or it never matches.
    const normalize = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const absolute = entryPoints.map((e) =>
        normalize(path.isAbsolute(e) ? e : path.resolve(root, e))
    );

    return {
        graph,
        entryIds: Array.from(graph.nodes.values())
            .filter((node) => node.path && absolute.includes(normalize(node.path)))
            .map((node) => node.id),
    };
}

export async function buildDependencyGraph(
    config: BuildConfig,
    cwd: string = process.cwd(),
): Promise<DependencyGraph> {
    const { DependencyGraph } = await import('./graph.js');
    const { PluginManager } = await import('../core/plugins/manager.js');
    const { getInfrastructurePreset } = await import('../presets/infrastructure.js');

    const root = config.root || cwd;
    const pluginManager = new PluginManager();

    // Infrastructure plugins carry the resolution rules (aliases, extensions,
    // framework loaders), so the graph is wrong without them.
    for (const p of getInfrastructurePreset(root)) await pluginManager.register(p);
    for (const p of config.plugins ?? []) await pluginManager.register(p);

    const graph = new DependencyGraph(pluginManager);

    const rawEntries = Array.isArray(config.entry)
        ? config.entry
        : config.entry
            ? [config.entry]
            : [];

    // The default entry is `index.html`, which is not a module: it has to be
    // expanded to the scripts it references first. Without this both
    // `lunx why` and `lunx inspect` crawled nothing and reported an empty
    // graph as a valid one.
    const { expandHtmlEntries } = await import('../build/html-entry.js');
    const { entryPoints } = expandHtmlEntries(rawEntries, root);

    for (const entry of entryPoints) {
        const absolute = path.isAbsolute(entry) ? entry : path.resolve(root, entry);
        await graph.addEntry(absolute, root);
    }

    return graph;
}
