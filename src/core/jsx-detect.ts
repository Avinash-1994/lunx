/** Cheap check for JSX in a `.js` file: a closing tag or a self-closing element. */
export function looksLikeJsx(code: string): boolean {
    return /<\/[A-Za-z][\w.:-]*\s*>|<[A-Za-z][\w.:-]*(\s[^<>]*)?\/>|<>|<\/>/.test(code);
}
