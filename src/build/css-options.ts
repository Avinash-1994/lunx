/**
 * The project's CSS options (`css.preprocessorOptions`, `css.modules`, as Vite's), set once
 * its config is loaded and read by the one CSS compiler (./css.ts) that dev, the build and
 * the plugin host share.
 */

export interface CssOptions {
    /** Per language (scss, sass, less, stylus): `additionalData` (prepended, or a function of the source) and the compiler's own options. */
    preprocessorOptions?: Record<string, Record<string, any>>;
    modules?: {
        /** Class name pattern: `[name]`, `[local]`, `[hash]` (`[hash:base64:5]` reads as `[hash]`). */
        generateScopedName?: string;
        /** The exported names: 'camelCase' adds camelCased keys, 'camelCaseOnly' keeps only them; 'dashes' / 'dashesOnly' convert dashes alone. */
        localsConvention?: 'camelCase' | 'camelCaseOnly' | 'dashes' | 'dashesOnly';
    };
}

const byRoot = new Map<string, CssOptions>();

export function setCssOptions(root: string, options: CssOptions | undefined): void {
    if (options && (options.preprocessorOptions || options.modules)) byRoot.set(root, options);
    else byRoot.delete(root);
}

export function cssOptions(root: string): CssOptions {
    return byRoot.get(root) ?? {};
}
