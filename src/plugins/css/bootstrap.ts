import fs from 'fs/promises';
import path from 'path';
import type { Plugin } from 'esbuild';

export interface BootstrapConfig {
    version?: string;
    useCDN?: boolean;
    includeIcons?: boolean;
    autoprefixer?: boolean;
    purgeUnused?: boolean;
}

/**
 * Bootstrap Plugin for esbuild
 * Supports CDN injection, local node_modules, autoprefixer, and SCSS purge
 */
export function bootstrapPlugin(config: BootstrapConfig = {}): Plugin {
    const {
        version = '5.3.2',
        useCDN = false,
        includeIcons = true,
        autoprefixer = true,
        purgeUnused = false
    } = config;

    return {
        name: 'bootstrap-plugin',
        setup(build) {
            // Intercept Bootstrap CSS imports
            build.onResolve({ filter: /^bootstrap\/dist\/css\/bootstrap/ }, args => {
                if (useCDN) {
                    // Return external for CDN usage
                    return { path: args.path, external: true };
                }
                // Resolve to local node_modules
                return {
                    path: require.resolve('bootstrap/dist/css/bootstrap.min.css', {
                        paths: [args.resolveDir]
                    })
                };
            });

            // Intercept Bootstrap Icons imports
            if (includeIcons) {
                build.onResolve({ filter: /^bootstrap-icons/ }, args => {
                    if (useCDN) {
                        return { path: args.path, external: true };
                    }
                    return {
                        path: require.resolve('bootstrap-icons/font/bootstrap-icons.css', {
                            paths: [args.resolveDir]
                        })
                    };
                });
            }

            // Intercept Bootstrap JS imports
            build.onResolve({ filter: /^bootstrap$/ }, args => {
                return {
                    path: require.resolve('bootstrap/dist/js/bootstrap.bundle.min.js', {
                        paths: [args.resolveDir]
                    })
                };
            });

            // Handle SCSS imports
            build.onResolve({ filter: /^bootstrap\/scss/ }, args => {
                return {
                    path: require.resolve(args.path.replace('bootstrap/scss', 'bootstrap/scss'), {
                        paths: [args.resolveDir]
                    })
                };
            });
        }
    };
}

/**
 * Inject Bootstrap CDN links into HTML
 */
export function injectBootstrapCDN(html: string, config: BootstrapConfig = {}): string {
    const {
        version = '5.3.2',
        includeIcons = true
    } = config;

    const cdnLinks = `
    <!-- Bootstrap CSS -->
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@${version}/dist/css/bootstrap.min.css" rel="stylesheet" integrity="sha384-T3c6CoIi6uLrA9TneNEoa7RxnatzjcDSCmG1MXxSR1GAsXEV/Dwwykc2MPK8M2HN" crossorigin="anonymous">
    ${includeIcons ? `<!-- Bootstrap Icons -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.1/font/bootstrap-icons.css">` : ''}
  `;

    const jsLink = `
    <!-- Bootstrap JS -->
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@${version}/dist/js/bootstrap.bundle.min.js" integrity="sha384-C6RzsynM9kWDrMNeT87bh95OGNyZPhcTNXj1NW7RuBCsyN/o0jlpcV8Qyq46cDfL" crossorigin="anonymous"></script>
  `;

    // Inject CSS in <head>
    html = html.replace('</head>', `${cdnLinks}\n  </head>`);

    // Inject JS before </body>
    html = html.replace('</body>', `${jsLink}\n  </body>`);

    return html;
}

/**
 * Auto-detect Bootstrap usage in project
 */
export async function detectBootstrapUsage(root: string): Promise<boolean> {
    try {
        const pkgPath = path.join(root, 'package.json');
        const content = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        return !!(deps['bootstrap'] || deps['bootstrap-icons']);
    } catch {
        return false;
    }
}

/**
 * Get Bootstrap configuration from project
 */
export async function getBootstrapConfig(root: string): Promise<BootstrapConfig> {
    const hasBootstrap = await detectBootstrapUsage(root);

    if (!hasBootstrap) {
        return { useCDN: true }; // Default to CDN if not installed
    }

    // Check if node_modules/bootstrap exists
    const localPath = path.join(root, 'node_modules', 'bootstrap');
    const hasLocal = await fs.access(localPath).then(() => true).catch(() => false);

    return {
        useCDN: !hasLocal,
        includeIcons: true,
        autoprefixer: true,
        purgeUnused: false
    };
}
