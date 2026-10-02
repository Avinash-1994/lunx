/**
 * React SSR Renderer
 * Server-side rendering for React/Next.js/Remix
 */

import { RenderContext } from './server.js';

/**
 * React is the *user's* dependency, not ours -- a build tool must not pin a UI
 * framework version. It is resolved from the project at render time, so the
 * React SSR path costs nothing when the project is Vue, Svelte or Solid.
 */
type ReactModule = { createElement: (type: any, props?: any, ...children: any[]) => unknown };
type ReactDOMServerModule = { renderToString: (element: unknown) => string };

let reactCache: Promise<[ReactModule, ReactDOMServerModule]> | null = null;

async function loadReact(): Promise<[ReactModule, ReactDOMServerModule]> {
    reactCache ??= (async () => {
        try {
            const [react, reactDomServer] = await Promise.all([
                import('react') as Promise<any>,
                import('react-dom/server') as Promise<any>,
            ]);
            return [(react.default ?? react) as ReactModule, (reactDomServer.default ?? reactDomServer) as ReactDOMServerModule];
        } catch (cause) {
            throw new Error(
                'React SSR requires `react` and `react-dom` in your project. Install them with: npm install react react-dom',
                { cause: cause as Error },
            );
        }
    })();
    return reactCache;
}

export interface ReactSSROptions {
    /** Enable streaming */
    streaming?: boolean;

    /** Custom wrapper component */
    wrapper?: unknown;
}

export class ReactSSRRenderer {
    private options: ReactSSROptions;

    constructor(options: ReactSSROptions = {}) {
        this.options = options;
    }

    /**
     * Render React component to HTML string
     */
    async render(Component: any, context: RenderContext): Promise<string> {
        try {
            // Create element with props
            const [React, { renderToString }] = await loadReact();
            const element = React.createElement(Component.default || Component, {
                ...context.data,
                params: context.params,
                searchParams: context.query,
            });

            // Wrap in custom wrapper if provided
            const wrappedElement = this.options.wrapper
                ? React.createElement(this.options.wrapper, {}, element)
                : element;

            // Render to string
            const html = renderToString(wrappedElement);

            return html;
        } catch (error: any) {
            console.error('React SSR Error Detailed:', {
                message: error.message,
                stack: error.stack,
                component: Component?.displayName || Component?.name
            });
            throw new Error(`Failed to render React component: ${error.message}\nStack: ${error.stack}`);
        }
    }

    /**
     * Render with streaming (React 18+)
     */
    async renderToStream(Component: any, context: RenderContext): Promise<ReadableStream> {
        // This would use renderToPipeableStream for Node.js
        // or renderToReadableStream for edge runtimes
        throw new Error('Streaming SSR not yet implemented');
    }
}
