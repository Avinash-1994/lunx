/** `node:path` (POSIX) for test files in the browser. */

const normalize = (p: string): string => {
    const abs = p.startsWith('/');
    const out: string[] = [];
    for (const part of p.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
    }
    return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
};
const join = (...parts: string[]) => normalize(parts.filter(Boolean).join('/'));
const resolve = (...parts: string[]) => {
    let p = '';
    for (const part of parts) p = part.startsWith('/') ? part : `${p}/${part}`;
    return normalize(p.startsWith('/') ? p : `/${p}`);
};
const dirname = (p: string) => {
    const i = p.replace(/\/+$/, '').lastIndexOf('/');
    return i <= 0 ? (p.startsWith('/') ? '/' : '.') : p.slice(0, i);
};
const basename = (p: string, ext?: string) => {
    const base = p.replace(/\/+$/, '').split('/').pop() ?? '';
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
};
const extname = (p: string) => {
    const base = basename(p);
    const i = base.lastIndexOf('.');
    return i <= 0 ? '' : base.slice(i);
};
const relative = (from: string, to: string) => {
    const a = resolve(from).split('/').filter(Boolean);
    const b = resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
};
const isAbsolute = (p: string) => p.startsWith('/');
const sep = '/';
const posix = { normalize, join, resolve, dirname, basename, extname, relative, isAbsolute, sep };

export { normalize, join, resolve, dirname, basename, extname, relative, isAbsolute, sep, posix };
export default { ...posix, posix };
