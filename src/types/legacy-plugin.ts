/**
 * The esbuild-style plugin shape (setup/onResolve/onLoad) used by the legacy
 * engine's federation and CSS-framework plugins. New code uses the Rollup
 * plugin shape through src/engines instead.
 */
export interface LegacyPluginBuild {
    initialOptions: Record<string, any>;
    onResolve(opts: { filter: RegExp; namespace?: string }, cb: (args: { path: string; importer: string; resolveDir: string; namespace?: string }) => any): void;
    onLoad(opts: { filter: RegExp; namespace?: string }, cb: (args: { path: string; namespace?: string }) => any): void;
}

export interface LegacyPlugin {
    name: string;
    setup(build: LegacyPluginBuild): void | Promise<void>;
}
