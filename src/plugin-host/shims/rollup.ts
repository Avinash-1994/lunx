/** The `rollup` module, on lunx's engine (Nitro bundles servers through it). */

export { rollup, VERSION, watch } from '../../engines/rollup-compat.js';

export function defineConfig<T>(config: T): T {
    return config;
}
