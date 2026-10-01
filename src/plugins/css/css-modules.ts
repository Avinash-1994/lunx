import fs from 'fs/promises';
import path from 'path';
import type { Plugin } from 'esbuild';
import crypto from 'crypto';

export interface CSSModulesConfig {
    generateScopedName?: string;
    exportGlobals?: boolean;
    generateTypings?: boolean;
}

/**
 * CSS Modules Plugin for esbuild
 * Transforms CSS files into scoped modules
 */
export function cssModulesPlugin(config: CSSModulesConfig = {}): Plugin {
    const {
        generateScopedName = '[name]__[local]___[hash:base64:5]',
        exportGlobals = false,
        generateTypings = true
    } = config;

    return {
        name: 'css-modules-plugin',
        setup(build) {
            // Intercept .module.css files
            build.onLoad({ filter: /\.module\.css$/ }, async (args) => {
                const source = await fs.readFile(args.path, 'utf-8');

                // Simple CSS Modules transformation
                const classNames: Record<string, string> = {};
                const cssLines: string[] = [];

                // Parse CSS and generate scoped names
                const classRegex = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
                let match;

                while ((match = classRegex.exec(source)) !== null) {
                    const originalName = match[1];
                    if (!classNames[originalName]) {
                        const hash = crypto.createHash('md5')
                            .update(args.path + originalName)
                            .digest('base64')
                            .substring(0, 5)
                            .replace(/[+/=]/g, '_');

                        const fileName = path.basename(args.path, '.module.css');
                        classNames[originalName] = `${fileName}__${originalName}___${hash}`;
                    }
                }

                // Replace class names in CSS
                let transformedCSS = source;
                for (const [original, scoped] of Object.entries(classNames)) {
                    transformedCSS = transformedCSS.replace(
                        new RegExp(`\\.${original}\\b`, 'g'),
                        `.${scoped}`
                    );
                }

                // Generate TypeScript declarations if enabled
                if (generateTypings) {
                    const dtsPath = args.path + '.d.ts';
                    const dtsContent = `declare const styles: {\n${Object.keys(classNames).map(name => `  ${name}: string;`).join('\n')
                        }\n};\nexport default styles;\n`;

                    await fs.writeFile(dtsPath, dtsContent);
                }

                // Return JavaScript module that exports class names
                const jsContent = `
          const styles = ${JSON.stringify(classNames)};
          
          // Inject CSS
          if (typeof document !== 'undefined') {
            const style = document.createElement('style');
            style.textContent = ${JSON.stringify(transformedCSS)};
            document.head.appendChild(style);
          }
          
          export default styles;
        `;

                return {
                    contents: jsContent,
                    loader: 'js'
                };
            });
        }
    };
}

/**
 * Auto-detect CSS Modules usage
 */
export async function detectCSSModules(root: string): Promise<boolean> {
    try {
        // Check for .module.css files
        const srcPath = path.join(root, 'src');
        const srcExists = await fs.access(srcPath).then(() => true).catch(() => false);

        if (!srcExists) return false;

        const files = await fs.readdir(srcPath, { recursive: true });
        return files.some((file: any) =>
            typeof file === 'string' && file.endsWith('.module.css')
        );
    } catch {
        return false;
    }
}

/**
 * Get CSS Modules configuration
 */
export async function getCSSModulesConfig(root: string): Promise<CSSModulesConfig> {
    const hasModules = await detectCSSModules(root);

    if (!hasModules) {
        return {};
    }

    return {
        generateScopedName: '[name]__[local]___[hash:base64:5]',
        exportGlobals: false,
        generateTypings: true
    };
}
