/**
 * Vue SSR Renderer
 * Server-side rendering for Vue 3 / Nuxt
 */

import { RenderContext } from './server.js';

/**
 * Vue is the *user's* dependency, not ours. Resolved from the project at
 * render time so a React or Svelte project never pays for it.
 */
type VueModule = { createSSRApp: (options: any) => any; h: (type: any, props?: any) => any };
type VueServerRendererModule = { renderToString: (app: any, context?: any) => Promise<string> };

let vueCache: Promise<[VueModule, VueServerRendererModule]> | null = null;

async function loadVue(): Promise<[VueModule, VueServerRendererModule]> {
    vueCache ??= (async () => {
        try {
            const [vue, serverRenderer] = await Promise.all([
                import('vue') as Promise<any>,
                import('@vue/server-renderer') as Promise<any>,
            ]);
            return [
                (vue.default ?? vue) as VueModule,
                (serverRenderer.default ?? serverRenderer) as VueServerRendererModule,
            ];
        } catch (cause) {
            throw new Error(
                'Vue SSR requires `vue` and `@vue/server-renderer` in your project. Install them with: npm install vue @vue/server-renderer',
                { cause: cause as Error },
            );
        }
    })();
    return vueCache;
}

export class VueSSRRenderer {
    /**
     * Render Vue component to HTML string
     */
    async render(Component: any, context: RenderContext): Promise<string> {
        try {
            const [{ createSSRApp, h }, { renderToString }] = await loadVue();

            // Create the app instance
            // Component.default is used if it's an ES module
            const app = createSSRApp({
                render: () => h(Component.default || Component, {
                    ...context.data,
                    params: context.params,
                    query: context.query
                })
            });

            // Set up error handling
            app.config.errorHandler = (err: unknown) => {
                console.error('Vue SSR App Error:', err);
            };

            // Render to string
            const html = await renderToString(app);

            return html;
        } catch (error: any) {
            console.error('Vue SSR Render Error:', error);
            throw new Error(`Failed to render Vue component: ${error.message}`);
        }
    }
}
