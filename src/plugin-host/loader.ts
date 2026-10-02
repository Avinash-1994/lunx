/**
 * Point `import 'vite'` (and `require('vite')`) at lunx's implementation for
 * the rest of the process, so framework plugins run on lunx instead of Vite.
 */

import module from 'node:module';

let installed = false;

/** The `vite` package's main entry, however it was reached. */
const VITE_ENTRY_RE = /\/node_modules\/vite\/dist\/node\/index\.js$/;

export function installRedirects(): void {
    if (installed) return;
    installed = true;
    // Child processes the framework starts get the same redirect.
    const register = new URL('./register.js', import.meta.url).href;
    if (!(process.env.NODE_OPTIONS ?? '').includes(register)) {
        process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${register}`.trim();
    }
    const shimUrl = new URL('./shim.js', import.meta.url).href;
    const registerHooks = (module as any).registerHooks as undefined | ((hooks: any) => void);
    if (registerHooks) {
        registerHooks({
            resolve(specifier: string, context: any, nextResolve: any) {
                if (specifier === 'vite') return { url: shimUrl, shortCircuit: true, format: 'module' };
                const result = nextResolve(specifier, context);
                // Frameworks that import Vite by path (SvelteKit's import_peer) land here.
                if (result?.url && VITE_ENTRY_RE.test(result.url)) return { url: shimUrl, shortCircuit: true, format: 'module' };
                return result;
            },
        });
        return;
    }
    // Node < 22.15: off-thread hooks (ESM imports only).
    const hooks = `export async function resolve(specifier, context, next) {
        if (specifier === 'vite') return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true };
        const result = await next(specifier, context);
        if (result && /\\/node_modules\\/vite\\/dist\\/node\\/index\\.js$/.test(result.url)) return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true };
        return result;
    }`;
    module.register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}
