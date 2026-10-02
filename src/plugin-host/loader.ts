/**
 * Point the build tools frameworks import (`vite`, `rollup`, Rollup's
 * resolve/commonjs/json/terser plugins) at lunx's own implementations for the
 * rest of the process, so none of their code runs.
 */

import module from 'node:module';

let installed = false;

/** Packages lunx stands in for: the build tools frameworks import, mapped to lunx's own modules. */
const REDIRECTS: Array<{ specifier: string; path: RegExp; to: string }> = [
    { specifier: 'vite', path: /\/node_modules\/vite\/dist\/node\/index\.js$/, to: './shim.js' },
    { specifier: 'rollup', path: /\/node_modules\/rollup\/dist\/(es\/)?rollup\.(m?js)$/, to: './shims/rollup.js' },
    { specifier: '@rollup/plugin-node-resolve', path: /\/node_modules\/@rollup\/plugin-node-resolve\/dist\/(es|cjs)\/index\.(m?js)$/, to: './shims/plugin-node-resolve.js' },
    { specifier: '@rollup/plugin-commonjs', path: /\/node_modules\/@rollup\/plugin-commonjs\/dist\/(es|cjs)\/index\.(m?js)$/, to: './shims/plugin-commonjs.js' },
    { specifier: '@rollup/plugin-json', path: /\/node_modules\/@rollup\/plugin-json\/dist\/(es|cjs)\/index\.(m?js)$/, to: './shims/plugin-json.js' },
    { specifier: '@rollup/plugin-terser', path: /\/node_modules\/@rollup\/plugin-terser\/dist\/(es|cjs)\/index\.(m?js)$/, to: './shims/plugin-terser.js' },
];

export function installRedirects(): void {
    if (installed) return;
    installed = true;
    // Child processes the framework starts get the same redirects.
    const register = new URL('./register.js', import.meta.url).href;
    if (!(process.env.NODE_OPTIONS ?? '').includes(register)) {
        process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${register}`.trim();
    }
    const targets = REDIRECTS.map((r) => ({ ...r, url: new URL(r.to, import.meta.url).href }));
    const registerHooks = (module as any).registerHooks as undefined | ((hooks: any) => void);
    if (registerHooks) {
        registerHooks({
            resolve(specifier: string, context: any, nextResolve: any) {
                const bySpecifier = targets.find((t) => t.specifier === specifier);
                if (bySpecifier) return { url: bySpecifier.url, shortCircuit: true, format: 'module' };
                const result = nextResolve(specifier, context);
                // Reached by path (SvelteKit's import_peer, nested copies): the same stand-in.
                const byPath = result?.url && targets.find((t) => t.path.test(result.url));
                if (byPath) return { url: byPath.url, shortCircuit: true, format: 'module' };
                return result;
            },
        });
        return;
    }
    // Node < 22.15: off-thread hooks (ESM imports only).
    const table = JSON.stringify(targets.map((t) => ({ specifier: t.specifier, path: t.path.source, url: t.url })));
    const hooks = `const targets = ${table}.map((t) => ({ ...t, path: new RegExp(t.path) }));
    export async function resolve(specifier, context, next) {
        const bySpecifier = targets.find((t) => t.specifier === specifier);
        if (bySpecifier) return { url: bySpecifier.url, shortCircuit: true };
        const result = await next(specifier, context);
        const byPath = result && targets.find((t) => t.path.test(result.url));
        if (byPath) return { url: byPath.url, shortCircuit: true };
        return result;
    }`;
    module.register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}
