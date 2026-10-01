import fs from 'fs/promises';
import path from 'path';
import type { Plugin } from 'esbuild';

export interface BulmaConfig {
    version?: string;
    useCDN?: boolean;
    includeExtensions?: boolean;
}

/**
 * Bulma Plugin for esbuild
 * Supports CDN injection and local node_modules
 */
export function bulmaPlugin(config: BulmaConfig = {}): Plugin {
    const {
        version = '0.9.4',
        useCDN = false,
        includeExtensions = false
    } = config;

    return {
        name: 'bulma-plugin',
        setup(build) {
            // Intercept Bulma CSS imports
            build.onResolve({ filter: /^bulma\/css\/bulma/ }, args => {
                if (useCDN) {
                    return { path: args.path, external: true };
                }
                return {
                    path: require.resolve('bulma/css/bulma.min.css', {
                        paths: [args.resolveDir]
                    })
                };
            });

            // Handle SASS imports
            build.onResolve({ filter: /^bulma$/ }, args => {
                return {
                    path: require.resolve('bulma/bulma.sass', {
                        paths: [args.resolveDir]
                    })
                };
            });
        }
    };
}

/**
 * Inject Bulma CDN link into HTML
 */
export function injectBulmaCDN(html: string, config: BulmaConfig = {}): string {
    const { version = '0.9.4' } = config;

    const cdnLink = `
    <!-- Bulma CSS -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bulma@${version}/css/bulma.min.css">
  `;

    // Inject CSS in <head>
    return html.replace('</head>', `${cdnLink}\n  </head>`);
}

/**
 * Auto-detect Bulma usage in project
 */
export async function detectBulmaUsage(root: string): Promise<boolean> {
    try {
        const pkgPath = path.join(root, 'package.json');
        const content = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        return !!deps['bulma'];
    } catch {
        return false;
    }
}

/**
 * Get Bulma configuration from project
 */
export async function getBulmaConfig(root: string): Promise<BulmaConfig> {
    const hasBulma = await detectBulmaUsage(root);

    if (!hasBulma) {
        return { useCDN: true };
    }

    const localPath = path.join(root, 'node_modules', 'bulma');
    const hasLocal = await fs.access(localPath).then(() => true).catch(() => false);

    return {
        useCDN: !hasLocal,
        includeExtensions: false
    };
}
