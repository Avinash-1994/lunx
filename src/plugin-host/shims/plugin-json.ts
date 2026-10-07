/**
 * `@rollup/plugin-json`: lunx's engine does this natively, so the factory
 * returns a marker carrying its options (see engines/rollup-compat.ts).
 */

export function json(options: Record<string, any> = {}): any {
    return { name: 'json', lunxNative: 'json', options };
}

export default json;
