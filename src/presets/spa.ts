import { Preset } from './index.js';
import { BuildConfig } from '../config/index.js';

export const spaPreset: Preset = {
    name: 'spa',
    apply(config: Partial<BuildConfig>): Partial<BuildConfig> {
        return {
            ...config,
            // A platform the project chose (node, edge) is kept: only the default is browser.
            platform: config.platform || 'browser',
            // In a real implementation, we would add specific SPA plugins here
            // e.g., history API fallback, specific chunking strategies
            esbuildPlugins: [
                ...(config.esbuildPlugins || []),
                // Placeholder for SPA specific plugins
            ]
        };
    }
};
