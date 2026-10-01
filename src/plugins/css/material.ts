import fs from 'fs/promises';
import path from 'path';
import type { Plugin } from 'esbuild';

export interface MaterialConfig {
    version?: string;
    useCDN?: boolean;
    includeIcons?: boolean;
    styledEngine?: 'emotion' | 'styled-components';
}

/**
 * Material UI Plugin for esbuild
 * Supports MUI v5 with Emotion or styled-components
 */
export function materialPlugin(config: MaterialConfig = {}): Plugin {
    const {
        version = '5.14.0',
        useCDN = false,
        includeIcons = true,
        styledEngine = 'emotion'
    } = config;

    return {
        name: 'material-plugin',
        setup(build) {
            // Intercept Material UI imports
            build.onResolve({ filter: /@mui\/material/ }, args => {
                return {
                    path: require.resolve('@mui/material', {
                        paths: [args.resolveDir]
                    })
                };
            });

            // Handle Emotion imports
            if (styledEngine === 'emotion') {
                build.onResolve({ filter: /@emotion\/(react|styled)/ }, args => {
                    return {
                        path: require.resolve(args.path, {
                            paths: [args.resolveDir]
                        })
                    };
                });
            }

            // Handle styled-components imports
            if (styledEngine === 'styled-components') {
                build.onResolve({ filter: /^styled-components$/ }, args => {
                    return {
                        path: require.resolve('styled-components', {
                            paths: [args.resolveDir]
                        })
                    };
                });
            }
        }
    };
}

/**
 * Inject Material UI CDN links into HTML
 */
export function injectMaterialCDN(html: string, config: MaterialConfig = {}): string {
    const { includeIcons = true } = config;

    const links = `
    <!-- Material Icons -->
    ${includeIcons ? '<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">' : ''}
    <!-- Roboto Font -->
    <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto:300,400,500,700&display=swap">
  `;

    return html.replace('</head>', `${links}\n  </head>`);
}

/**
 * Auto-detect Material UI usage in project
 */
export async function detectMaterialUsage(root: string): Promise<boolean> {
    try {
        const pkgPath = path.join(root, 'package.json');
        const content = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        return !!(deps['@mui/material'] || deps['material-design-lite'] || deps['@material/web']);
    } catch {
        return false;
    }
}

/**
 * Get Material UI configuration from project
 */
export async function getMaterialConfig(root: string): Promise<MaterialConfig> {
    const hasMaterial = await detectMaterialUsage(root);

    if (!hasMaterial) {
        return { useCDN: true };
    }

    // Check which styled engine is installed
    try {
        const pkgPath = path.join(root, 'package.json');
        const content = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        const styledEngine = deps['@emotion/react'] ? 'emotion' :
            deps['styled-components'] ? 'styled-components' :
                'emotion';

        return {
            useCDN: false,
            includeIcons: true,
            styledEngine
        };
    } catch {
        return { useCDN: true };
    }
}
