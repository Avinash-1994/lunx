import fs from 'fs/promises';
import path from 'path';
import type { Plugin } from 'esbuild';

export interface EmotionConfig {
    ssr?: boolean;
    cssProp?: boolean;
    autoLabel?: boolean;
    labelFormat?: string;
}

/**
 * Emotion Plugin for esbuild
 * Integrates @emotion/babel-plugin for css prop and optimization
 */
export function emotionPlugin(config: EmotionConfig = {}): Plugin {
    const {
        ssr = false,
        cssProp = true,
        autoLabel = true,
        labelFormat = '[local]'
    } = config;

    return {
        name: 'emotion-plugin',
        setup(build) {
            // Intercept @emotion/react imports
            build.onResolve({ filter: /@emotion\/react/ }, args => {
                return {
                    path: require.resolve('@emotion/react', {
                        paths: [args.resolveDir]
                    })
                };
            });

            // Intercept @emotion/styled imports
            build.onResolve({ filter: /@emotion\/styled/ }, args => {
                return {
                    path: require.resolve('@emotion/styled', {
                        paths: [args.resolveDir]
                    })
                };
            });

            // For SSR
            if (ssr) {
                build.onResolve({ filter: /@emotion\/server/ }, args => {
                    return {
                        path: require.resolve('@emotion/server', {
                            paths: [args.resolveDir]
                        })
                    };
                });
            }
        }
    };
}

/**
 * Get Babel plugin configuration for Emotion
 */
export function getEmotionBabelConfig(config: EmotionConfig = {}) {
    const {
        ssr = false,
        cssProp = true,
        autoLabel = true,
        labelFormat = '[local]'
    } = config;

    return {
        plugins: [
            [
                '@emotion/babel-plugin',
                {
                    sourceMap: true,
                    autoLabel: autoLabel ? 'dev-only' : 'never',
                    labelFormat,
                    cssPropOptimization: cssProp
                }
            ]
        ],
        // Enable JSX runtime for css prop
        ...(cssProp ? {
            presets: [
                ['@babel/preset-react', {
                    runtime: 'automatic',
                    importSource: '@emotion/react'
                }]
            ]
        } : {})
    };
}

/**
 * Auto-detect Emotion usage
 */
export async function detectEmotion(root: string): Promise<boolean> {
    try {
        const pkgPath = path.join(root, 'package.json');
        const content = await fs.readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        return !!(deps['@emotion/react'] || deps['@emotion/styled']);
    } catch {
        return false;
    }
}

/**
 * Get Emotion configuration
 */
export async function getEmotionConfig(root: string): Promise<EmotionConfig> {
    const hasEmotion = await detectEmotion(root);

    if (!hasEmotion) {
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
            cssProp: true,
            autoLabel: true,
            labelFormat: '[local]'
        };
    } catch {
        return {};
    }
}
