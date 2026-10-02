/**
 * Hot updates the way Vite does them: on a file change run the per-environment
 * `hotUpdate` hooks (and the legacy `handleHotUpdate`), walk the client graph
 * up to the nearest modules that accept the change, and send `update` (or
 * `full-reload` when nothing accepts it). Server modules are invalidated so
 * the next ssrLoadModule re-evaluates them.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getHookHandler, sortByHook } from './config.js';
import type { DevEnvironment } from './environment.js';
import type { EnvironmentModuleNode } from './module-graph.js';
import { isCSSRequest, isJSRequest, normalizePath } from './utils.js';

interface Boundary {
    boundary: EnvironmentModuleNode;
    acceptedVia: EnvironmentModuleNode;
    isWithinCircularImport: boolean;
}

export async function handleHMRUpdate(type: 'create' | 'update' | 'delete', file: string, server: any): Promise<void> {
    const { config, environments } = server;
    const timestamp = Date.now();
    const shortFile = normalizePath(path.relative(config.root, file));

    if (config.configFileDependencies?.includes(file) || /(^|[\\/])\.env(\.|$)/.test(path.basename(file))) {
        config.logger.info(`${shortFile} changed, restarting server...`, { timestamp: true });
        await server.restart();
        return;
    }

    const read = () => fs.readFile(file, 'utf-8');
    let legacyRan = false;
    for (const env of Object.values(environments) as DevEnvironment[]) {
        let modules = [...(env.moduleGraph.getModulesByFile(file) ?? [])];
        if (type === 'create') {
            for (const mod of env.moduleGraph.idToModuleMap.values()) {
                if (mod.ssrError || (mod as any).loadError) modules.push(mod);
            }
        }
        const ctx: any = { type, file, timestamp, modules, read, server };
        for (const plugin of sortByHook(env.pluginContainer.plugins, 'hotUpdate')) {
            const result = await getHookHandler(plugin.hotUpdate)!.call({ environment: env }, ctx);
            if (result) ctx.modules = modules = result;
        }
        if (env.isClient && !legacyRan) {
            legacyRan = true;
            const mixed = modules.map((m) => server.moduleGraph.wrap(m));
            const legacyCtx = { file, timestamp, modules: mixed, read, server };
            for (const plugin of sortByHook(config.plugins, 'handleHotUpdate')) {
                const result = await getHookHandler(plugin.handleHotUpdate)!.call({}, legacyCtx);
                if (result) {
                    legacyCtx.modules = result;
                    modules = result.map((m: any) => m._clientModule).filter(Boolean);
                }
            }
        }
        if (!env.isClient) {
            const seen = new Set<EnvironmentModuleNode>();
            for (const mod of modules) env.moduleGraph.invalidateModule(mod, seen, timestamp, true);
            continue;
        }
        if (!modules.length) {
            if (file.endsWith('.html') && (env.moduleGraph.getModulesByFile(file) || path.dirname(file).startsWith(config.root))) {
                config.logger.info(`page reload ${shortFile}`, { timestamp: true });
                env.hot.send({ type: 'full-reload', path: config.server.middlewareMode ? '*' : '/' + normalizePath(path.relative(config.root, file)) });
            }
            continue;
        }
        updateModules(env, shortFile, modules, timestamp);
    }
}

export function updateModules(env: DevEnvironment, file: string, modules: EnvironmentModuleNode[], timestamp: number, afterInvalidation = false): void {
    const updates: any[] = [];
    const invalidated = new Set<EnvironmentModuleNode>();
    const traversed = new Set<EnvironmentModuleNode>();
    let needFullReload: string | false = false;

    for (const mod of modules) {
        const boundaries: Boundary[] = [];
        const hasDeadEnd = propagateUpdate(mod, traversed, boundaries);
        env.moduleGraph.invalidateModule(mod, invalidated, timestamp, true);
        if (needFullReload) continue;
        if (hasDeadEnd) {
            needFullReload = typeof hasDeadEnd === 'string' ? hasDeadEnd : true as any;
            continue;
        }
        for (const { boundary, acceptedVia, isWithinCircularImport } of boundaries) {
            updates.push({
                type: `${boundary.type}-update`,
                timestamp,
                path: boundary.url,
                acceptedPath: acceptedVia.url,
                explicitImportRequired: boundary.type === 'js' ? !isJSRequest(acceptedVia.url) && !isCSSRequest(acceptedVia.url) : false,
                isWithinCircularImport,
            });
        }
    }

    if (needFullReload) {
        env.logger.info(`page reload ${file}${afterInvalidation ? ' (invalidated)' : ''}`, { timestamp: true });
        env.hot.send({ type: 'full-reload', triggeredBy: file });
        return;
    }
    if (!updates.length) return;
    env.logger.info(`hmr update ${[...new Set(updates.map((u) => u.path))].join(', ')}`, { timestamp: true });
    env.hot.send({ type: 'update', updates });
}

/** True when some import chain reaches an entry without an accepting module. */
function propagateUpdate(node: EnvironmentModuleNode, traversed: Set<EnvironmentModuleNode>, boundaries: Boundary[], chain: EnvironmentModuleNode[] = [node]): boolean {
    if (traversed.has(node)) return false;
    traversed.add(node);
    if (node.id && node.isSelfAccepting === undefined) return false;
    if (node.isSelfAccepting) {
        boundaries.push({ boundary: node, acceptedVia: node, isWithinCircularImport: isWithinCircular(node, chain) });
        for (const importer of node.importers) {
            if (isCSSRequest(importer.url) && !chain.includes(importer)) propagateUpdate(importer, traversed, boundaries, chain.concat(importer));
        }
        return false;
    }
    if (!node.importers.size) return true;
    if (!isCSSRequest(node.url) && [...node.importers].every((i) => isCSSRequest(i.url))) return true;
    for (const importer of node.importers) {
        const subChain = chain.concat(importer);
        if (importer.acceptedHmrDeps.has(node)) {
            boundaries.push({ boundary: importer, acceptedVia: node, isWithinCircularImport: isWithinCircular(importer, subChain) });
            continue;
        }
        if (!chain.includes(importer) && propagateUpdate(importer, traversed, boundaries, subChain)) return true;
    }
    return false;
}

function isWithinCircular(node: EnvironmentModuleNode, chain: EnvironmentModuleNode[], seen = new Set<EnvironmentModuleNode>()): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    for (const importer of node.importers) {
        if (chain.includes(importer)) return true;
        if (isWithinCircular(importer, chain, seen)) return true;
    }
    return false;
}
