/**
 * `@rollup/plugin-terser`: lunx's engine does this natively, so the factory
 * returns a marker carrying its options (see engines/rollup-compat.ts).
 */

export function terser(options: Record<string, any> = {}): any {
    return { name: 'terser', lunxNative: 'terser', options };
}

export default terser;
