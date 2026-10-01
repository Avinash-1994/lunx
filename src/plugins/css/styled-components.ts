import fs from 'fs/promises';
import path from 'path';
import type { Plugin } from 'esbuild';

export interface StyledComponentsConfig {
    ssr?: boolean;
    displayName?: boolean;
    fileName?: boolean;
    minify?: boolean;
}

/**
 * styled-components Plugin for esbuild
 * Integrates babel-plugin-styled-components for better DX and optimization
 */
export function styledComponentsPlugin(config: StyledComponentsConfig = {}): Plugin {
    const {
        ssr = false,
        displayName = true,
        fileName = true,
        minify = false
    } = config;

    return {
        name: 'styled-components-plugin',
        setup(build) {
            // Intercept styled-components imports
            build.onResolve({ filter: /^styled-components$/ }, args => {
                return {
                    path: require.resolve('styled-components', {
                        paths: [args.resolveDir]
                    })
                };
            });

            // For SSR, we need to handle the ServerStyleSheet
            if (ssr) {
                build.onResolve({ filter: /styled-components\/.*ServerStyleSheet/ }, args => {
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
 * Get Babel plugin configuration for styled-components
 */
export function getStyledComponentsBabelConfig(config: StyledComponentsConfig = {}) {
    const {
        ssr = false,
        displayName = true,
        fileName = true,
        minify = false
    } = config;

    return {
        plugins: [
            [
                'babel-plugin-styled-components',
                {
                    ssr,
                    displayName,
                    fileName,
                    minify,
                    transpileTemplateLiterals: true,
                    pure: true // Enable tree-shaking
                }
            ]
        ]
    };
}

/**
 * Auto-detect styled-components usage
 */
export async function detectStyledComponents(root: string): Promise<boolean> {
    try {
        const pkgPath = path.join(root, 'package.json');
        const content = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        return !!deps['styled-components'];
    } catch {
        return false;
    }
}

/**
 * Get styled-components configuration
 */
export async function getStyledComponentsConfig(root: string): Promise<StyledComponentsConfig> {
    const hasStyled = await detectStyledComponents(root);

    if (!hasStyled) {
        return {};
    }

    // Check for SSR frameworks
    try {
        const pkgPath = path.join(root, 'package.json');
        const content = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        const isSSR = !!(deps['next'] || deps['@remix-run/react'] || deps['gatsby']);

        return {
            ssr: isSSR,
            displayName: true,
            fileName: true,
            minify: false
        };
    } catch {
        return {};
    }
}
