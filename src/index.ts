/**
 * Lunx Build Tool - Public API
 * 
 * This is the ONLY stable public surface for Lunx.
 * Everything not exported here is considered internal and may change without notice.
 * 
 * @public
 * @stable
 */

// ============================================================================
// CORE BUILD API
// ============================================================================

export { CoreBuildEngine } from './core/engine/index.js';
export type { BuildFingerprint, BuildArtifact, BuildMode } from './core/engine/types.js';

// ============================================================================
// MODULE FEDERATION (Fixed Runtime — replaces stub in plugins/federation_next.ts)
// ============================================================================

export {
    generateRemoteEntry,
    generateFederationRuntime,
    federationPlugin,
    injectRemotesIntoHTML,
    validateFederationConfig,
    SHARED_SCOPE_RUNTIME,
} from './federation/index.js';
export type {
    FederationConfig as MFConfig,
    SharedConfig,
    FederationBuildResult,
} from './federation/index.js';

// ============================================================================
// ENV SYSTEM (.env → import.meta.env.LUNX_*)
// ============================================================================

export { loadEnv, getEsbuildDefines, warnSensitiveEnv } from './env.js';
export type { EnvConfig, LoadedEnv } from './env.js';

// ============================================================================
// CONFIG LOADER (extends + deep merge + validation)
// ============================================================================

export { loadConfigExtended, mergeConfig, findConfigFile, validateConfig } from './config-loader.js';
export type { LunxConfig, LoadConfigResult, ConfigValidationResult } from './config-loader.js';

// ============================================================================
// COMMANDS (Preview server + Library build)
// ============================================================================

export { preview } from './commands/preview.js';
export type { PreviewOptions } from './commands/preview.js';

export { buildLib } from './commands/lib-build.js';
export type { LunxLibConfig, LibBuildResult } from './commands/lib-build.js';

// ============================================================================
// DEV MIDDLEWARE (proxy + CORS + request logger)
// ============================================================================

export { applyMiddleware, applyProxies, applyCORS, applyRequestLogger } from './dev-middleware.js';
export type { MiddlewareFn } from './dev-middleware.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

export { loadConfig, defineConfig } from './config/index.js';
export type { BuildConfig } from './config/index.js';

// ============================================================================
// PLUGIN SYSTEM (Public Extension Surface #1)
// ============================================================================

export type {
    LunxPlugin,
    PluginHookName,
    PluginManifest,
    PluginType
} from './core/plugins/types.js';

export { PluginManager } from './core/plugins/manager.js';

// Plugin Factories (Official Plugins Only)
export { createJsTransformPlugin } from './plugins/js-transform.js';
export { createAssetPlugin } from './plugins/assets.js';
export { createPostCssPlugin } from './plugins/css/postcss.js';
export { createFederationPlugin } from './plugins/federation_next.js';
export type { FederationConfig } from './plugins/federation_next.js';

// ============================================================================
// FRAMEWORK PRESETS (Public Extension Surface #2)
// ============================================================================

export type { Framework } from './core/framework-detector.js';
export type { FrameworkPreset } from './presets/frameworks.js';
export { getFrameworkPreset, frameworkPresets } from './presets/frameworks.js';

// ============================================================================
// INSPECTOR API (Public Extension Surface #3)
// ============================================================================

export { DependencyGraph } from './resolve/graph.js';
export type { GraphNode, GraphEdge } from './resolve/graph.js';

// ============================================================================
// UTILITIES (Stable Helpers)
// ============================================================================

export { log } from './utils/logger.js';

// ============================================================================
// PLUGIN ADAPTERS (Community Ecosystem)
// ============================================================================

export { adaptPlugin } from './marketplace/plugin-adapter.js';
export type { CommunityPlugin } from './marketplace/plugin-adapter.js';

// ============================================================================
// INTERNAL APIs - DO NOT USE
// ============================================================================

/**
 * @internal
 * The following are NOT part of the public API and may change at any time:
 * 
 * - src/core/engine/config.ts (initBuild, attachGraph, etc.)
 * - src/core/engine/plan.ts (planBuild, planParallelExecution)
 * - src/core/engine/execute.ts (executeParallel)
 * - src/core/engine/optimize.ts (optimizeArtifacts)
 * - src/core/engine/emit.ts (emit)
 * - src/core/engine/hash.ts (canonicalHash)
 * - src/resolve/* (except DependencyGraph)
 * - src/build/* (legacy bundler)
 * - src/dev/* (dev server internals)
 * - src/ai/* (experimental features)
 * - src/meta-frameworks/* (experimental)
 * 
 * Using these will break your code in future versions.
 */

// ============================================================================
// JAVASCRIPT API (as Vite's build() and createServer())
// ============================================================================

export interface InlineConfig extends Record<string, any> {
    /** Project root (default: the current directory). Its lunx.config / vite.config applies underneath. */
    root?: string;
    mode?: string;
}

/** Build the app in `root`, as `lunx build`: the project's config, with `inline` over it. */
export async function build(inline: InlineConfig = {}) {
    const path = await import('node:path');
    const root = path.resolve(inline.root ?? process.cwd());
    const { loadConfig } = await import('./config/index.js');
    const { mergeConfig } = await import('./config-loader.js');
    const config: any = mergeConfig((await loadConfig(root)) as any, inline as any);
    config.root = root;
    config.mode = inline.mode ?? 'production';
    const { build: runBuild } = await import('./build/bundler.js');
    return runBuild(config);
}

/**
 * The dev server, as `lunx dev`. With `server: { middlewareMode: true }` it does not
 * listen: mount `middlewares` in your own server, and pass that server as
 * `server.hmr.server` for live updates.
 *
 *   const lunx = await createServer({ server: { middlewareMode: true, hmr: { server: httpServer } } });
 *   app.use(lunx.middlewares);
 */
export async function createServer(inline: InlineConfig = {}) {
    const path = await import('node:path');
    const root = path.resolve(inline.root ?? process.cwd());
    const { startDevServer } = await import('./dev/devServer.js');
    const server: any = await startDevServer({ ...inline, root, mode: inline.mode ?? 'development' } as any);
    const handler = () => server.__lunx_handler ?? server.requestHandler;
    return {
        httpServer: server,
        /** Connect / Express middleware: lunx answers what it serves. */
        middlewares: (req: any, res: any) => handler()(req, res),
        async close(): Promise<void> {
            server.wsServer?.close?.();
            if (!inline.server?.middlewareMode) await new Promise<void>((resolve) => (server.close ? server.close(() => resolve()) : resolve()));
        },
    };
}
