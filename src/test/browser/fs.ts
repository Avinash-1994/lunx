/**
 * `node:fs` for test files in the browser: the files the runner handed the page
 * (snapshots), and the writes it takes back when the file is done.
 */

const files: Record<string, string> = (globalThis as any).__lunx_files ?? {};
export const writes: Record<string, string | null> = {};

const missing = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });

function readFileSync(p: string): string {
    if (p in writes) {
        if (writes[p] === null) throw missing(p);
        return writes[p]!;
    }
    if (p in files) return files[p]!;
    throw missing(p);
}
const writeFileSync = (p: string, data: unknown) => void (writes[p] = String(data));
const existsSync = (p: string) => (p in writes ? writes[p] !== null : p in files);
const mkdirSync = () => undefined;
const rmSync = (p: string) => void (writes[p] = null);

export { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync };
export default { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync };
