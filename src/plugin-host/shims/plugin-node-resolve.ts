/**
 * `@rollup/plugin-node-resolve`: lunx's engine does this natively, so the factory
 * returns a marker carrying its options (see engines/rollup-compat.ts).
 */

export function nodeResolve(options: Record<string, any> = {}): any {
    return { name: 'node-resolve', lunxNative: 'node-resolve', options };
}

export default nodeResolve;
