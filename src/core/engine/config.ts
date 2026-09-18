
/**
 * Engine Configuration and Initialization
 * 
 * @internal - This is part of the core engine and NOT a public API.
 */

import { BuildConfig } from '../../config/index.js';
import { BuildContext, ResolvedConfig, BuildMode, EngineInfo, InputFingerprint } from './types.js';
import { InMemoryBuildCache, PersistentBuildCache } from './cache.js';
import { DependencyGraph } from '../../resolve/graph.js';
import { explainReporter } from './events.js';
import { canonicalHash } from './hash.js';
import fs from 'fs/promises';
import path from 'path';

import { PluginManager } from '../plugins/manager.js';
import { getInfrastructurePreset } from '../../presets/infrastructure.js';
import { expandHtmlEntries } from '../../build/html-entry.js';

// Stage 1: Initialization
export async function initBuild(
    userConfig: BuildConfig,
    mode: BuildMode,
    rootDir: string
): Promise<BuildContext> {
    explainReporter.report('init', 'initialize', 'Starting build initialization');

    const engine: EngineInfo = {
        name: "Lunx",
        version: "0.1.3", // Should normally come from package.json
        buildTime: new Date().toISOString()
    };

    const config: ResolvedConfig = resolveConfig(userConfig, rootDir, mode);
    // cache may be false (legacy boolean) or an object with remote config
    const useCache = userConfig.cache !== false && userConfig.cache !== undefined;
    const cache = useCache ? new PersistentBuildCache(rootDir) : new InMemoryBuildCache();
    const pluginManager = new PluginManager();

    // 1. Register Infrastructure (Phase B2)
    const infraPlugins = getInfrastructurePreset(rootDir, config.outputDir, config);
    for (const p of infraPlugins) {
        await pluginManager.register(p);
    }

    // 2. Register User Plugins (Phase F2)
    if (userConfig.plugins) {
        for (const p of userConfig.plugins) {
            await pluginManager.register(p);
        }
    }

    explainReporter.report('init', 'config_resolved', 'Config frozen', { config });

    return {
        engine,
        mode,
        rootDir,
        env: process.env as Record<string, string>,
        target: userConfig.platform || 'browser',
        graph: new DependencyGraph(), // Empty initially
        graphHash: '', // Placeholder
        cache,
        config,
        pluginManager
    };
}

function resolveConfig(userConfig: BuildConfig, rootDir: string, mode: BuildMode): ResolvedConfig {
    const sourcemap = userConfig.build?.sourcemap;
    const rawEntries = Array.isArray(userConfig.entry)
        ? userConfig.entry
        : (userConfig.entry ? [userConfig.entry] : []);
    const { entryPoints, htmlTemplates } = expandHtmlEntries(rawEntries, rootDir);
    return {
        entryPoints,
        htmlTemplates,
        outputDir: path.isAbsolute(userConfig.outDir || 'dist')
            ? userConfig.outDir
            : path.resolve(rootDir, userConfig.outDir || 'dist'),
        publicPath: '/',
        splittingStrategy: userConfig.build?.splitting ? 'module' : 'route',
        hashing: 'content',
        sourceMaps: sourcemap === 'none' ? false : (sourcemap === undefined ? 'external' : sourcemap),
        minify: userConfig.build?.minify ?? (mode === 'production' || mode === 'build'),
        cssModules: userConfig.build?.cssModules ?? false,
        federation: userConfig.federation,
    };
}

// Stage 2: Input Fingerprinting
export async function computeInputFingerprint(ctx: BuildContext): Promise<InputFingerprint> {
    explainReporter.report('fingerprint', 'start', 'Computing input fingerprint');

    // 1. Hash Config
    // Normalize absolute paths to ensure deterministic hash across environments (CI vs Local)
    const normalizedConfig = {
        ...ctx.config,
        outputDir: path.relative(ctx.rootDir, ctx.config.outputDir)
    };
    const configHash = canonicalHash(normalizedConfig);

    // 2. Hash Engine
    // We strictly use version/name, NOT buildTime for semantic hash
    const engineFingerprint = canonicalHash({ name: ctx.engine.name, version: ctx.engine.version });

    // 3. Hash Source Files - only relevant build inputs.
    // Scanning the whole repository on every cold start is expensive for large monorepos,
    // so we limit this fingerprint step to the actual entry files and the primary project metadata.
    const sourceFiles: { path: string, contentHash: string }[] = [];

    async function hashPath(filePath: string) {
        try {
            const content = await fs.readFile(filePath);
            sourceFiles.push({ path: path.relative(ctx.rootDir, filePath), contentHash: canonicalHash(content) });
        } catch {
            // Ignore missing or unreadable files; this is a best-effort fingerprint.
        }
    }

    for (const entry of ctx.config.entryPoints) {
        const absEntry = path.isAbsolute(entry) ? entry : path.resolve(ctx.rootDir, entry);
        await hashPath(absEntry);
    }

    for (const html of ctx.config.htmlTemplates || []) {
        const absHtml = path.isAbsolute(html) ? html : path.resolve(ctx.rootDir, html);
        await hashPath(absHtml);
    }

    // Include the main package manifest and local build config so dependency and plugin changes are captured.
    await hashPath(path.resolve(ctx.rootDir, 'package.json'));
    await hashPath(path.resolve(ctx.rootDir, 'lunx.config.js'));
    await hashPath(path.resolve(ctx.rootDir, 'package-lock.json'));
    await hashPath(path.resolve(ctx.rootDir, 'pnpm-lock.yaml'));

    sourceFiles.sort((a, b) => a.path.localeCompare(b.path));

    const inputsToHash = {
        config: configHash,
        engine: engineFingerprint,
        sources: sourceFiles
    };

    const inputHash = canonicalHash(inputsToHash);

    explainReporter.report('fingerprint', 'computed', 'Input fingerprint ready', { inputHash });

    return {
        sourceFiles,
        configHash,
        engineFingerprint,
        inputHash
    };
}

// Stage 3: Attach Graph
export function attachGraph(ctx: BuildContext, graph: DependencyGraph): BuildContext {
    explainReporter.report('graph', 'attached', 'Dependency graph attached');

    // Compute Graph Hash
    const nodesObj: Record<string, any> = {};
    for (const [key, val] of graph.nodes.entries()) {
        const deps = val.edges.map(e => e.to).sort();
        nodesObj[key] = {
            id: val.id,
            contentHash: val.contentHash,
            deps: deps
        };
    }
    const graphHash = canonicalHash(nodesObj);

    return {
        ...ctx,
        graph,
        graphHash
    };
}
