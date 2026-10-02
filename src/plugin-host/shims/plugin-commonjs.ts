/**
 * `@rollup/plugin-commonjs`: lunx's engine does this natively, so the factory
 * returns a marker carrying its options (see engines/rollup-compat.ts).
 */

export function commonjs(options: Record<string, any> = {}): any {
    return { name: 'commonjs', lunxNative: 'commonjs', options };
}

export default commonjs;
