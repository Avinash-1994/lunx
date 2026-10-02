/**
 * Point `import 'vite'` (and `require('vite')`) at lunx's implementation for
 * the rest of the process, so framework plugins run on lunx instead of Vite.
 */

import module from 'node:module';

let installed = false;

export function installViteRedirect(): void {
    if (installed) return;
    installed = true;
    const shimUrl = new URL('./shim.js', import.meta.url).href;
    const registerHooks = (module as any).registerHooks as undefined | ((hooks: any) => void);
    if (registerHooks) {
        registerHooks({
            resolve(specifier: string, context: any, nextResolve: any) {
                if (specifier === 'vite') return { url: shimUrl, shortCircuit: true, format: 'module' };
                return nextResolve(specifier, context);
            },
        });
        return;
    }
    // Node < 22.15: off-thread hooks (ESM imports only).
    const hooks = `export async function resolve(specifier, context, next) {
        if (specifier === 'vite') return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true };
        return next(specifier, context);
    }`;
    module.register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}
