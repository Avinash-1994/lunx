import fs from 'fs/promises';
import path from 'path';
import { LunxPlugin } from '../core/plugins/types.js';
import {
    fallbackHtmlShell,
    rewriteHtmlForProduction,
} from '../build/html-entry.js';

export function createHtmlPlugin(rootDir: string, outDir: string): LunxPlugin {
    return {
        manifest: {
            name: 'lunx:html',
            version: '1.0.0',
            engineVersion: '1.0.0',
            type: 'js',
            hooks: ['buildEnd'],
            permissions: { fs: 'read' }
        },
        id: 'lunx:html',
        async runHook(hook, data, context) {
            if (hook !== 'buildEnd') return data;

            const { artifacts } = data;
            const ctx = data.ctx || context;
            const publicPath = ctx?.config?.publicPath || '/';
            const templates: string[] = ctx?.config?.htmlTemplates?.length
                ? ctx.config.htmlTemplates
                : ['index.html', 'src/index.html'];

            const htmlArtifacts: any[] = [];
            for (const rel of templates) {
                const abs = path.isAbsolute(rel) ? rel : path.join(rootDir, rel);
                let source: string | null = null;
                try {
                    source = await fs.readFile(abs, 'utf-8');
                } catch {
                    continue;
                }
                const rewritten = rewriteHtmlForProduction(source, artifacts, {
                    publicPath,
                    htmlFileAbs: abs,
                    rootDir,
                });
                htmlArtifacts.push({
                    id: `html:${rel}`,
                    type: 'asset',
                    fileName: 'index.html',
                    source: rewritten,
                    dependencies: []
                });
                break;
            }

            if (htmlArtifacts.length === 0) {
                htmlArtifacts.push({
                    id: 'index-html',
                    type: 'asset',
                    fileName: 'index.html',
                    source: fallbackHtmlShell(artifacts, publicPath),
                    dependencies: []
                });
            }

            const withoutGeneratedHtml = artifacts.filter((a: any) => a.fileName !== 'index.html');
            return {
                ...data,
                artifacts: [...withoutGeneratedHtml, ...htmlArtifacts]
            };
        }
    };
}
