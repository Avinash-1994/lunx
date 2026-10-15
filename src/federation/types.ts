/**
 * Type hints across module federation, in the layout `@module-federation`'s
 * dts plugin uses, so lunx, webpack and Rspack apps read each other's types:
 *
 *  - a remote's build writes `@mf-types/` (declarations under
 *    `compiled-types/`, one `<expose>.d.ts` per exposed module, re-exporting
 *    it), `@mf-types.zip` and `@mf-types.d.ts` (keys for `loadRemote`);
 *  - a host downloads each remote's `@mf-types.zip` (next to its remoteEntry)
 *    into `@mf-types/<remote>/`, which tsconfig's `"paths": { "*": ["./@mf-types/*"] }`
 *    maps `remote/Module` imports to.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FederationOptions } from './engine.js';

export const TYPES_FOLDER = '@mf-types';
const COMPILED = 'compiled-types';

/** `federation.dts`: on unless `false`; `{ generateTypes, consumeTypes }` picks a side. */
export function dtsSides(options: FederationOptions): { generate: boolean; consume: boolean } {
    const dts = (options as any).dts;
    if (dts === false) return { generate: false, consume: false };
    const o = typeof dts === 'object' && dts ? dts : {};
    return { generate: o.generateTypes !== false, consume: o.consumeTypes !== false };
}

/** A remote's build: declarations of what it exposes. Returns the files written, or null (no TypeScript). */
export async function generateRemoteTypes(root: string, outDir: string, options: FederationOptions, modules: string[]): Promise<string[] | null> {
    if (!options.exposes || !Object.keys(options.exposes).length) return null;
    if (!['tsconfig.json', 'jsconfig.json'].some((f) => fs.existsSync(path.join(root, f)))) return null;
    const exposed: Record<string, string> = {};
    for (const [key, spec] of Object.entries(options.exposes)) {
        const file = resolveSource(path.resolve(root, spec));
        if (file && /\.(m|c)?tsx?$/.test(file)) exposed[key] = file;
    }
    if (!Object.keys(exposed).length) return null;
    const typesDir = path.join(outDir, TYPES_FOLDER);
    const compiledDir = path.join(typesDir, COMPILED);
    await fsp.rm(typesDir, { recursive: true, force: true });
    const { emitDeclarations } = await import('../build/library.js');
    // Type-only imports never reach the bundle: follow the sources' own imports too.
    const sources = typeClosure([...Object.values(exposed), ...modules.filter((m) => !m.includes('node_modules') && !m.startsWith('\0') && /\.(m|c)?tsx?$/.test(m))]);
    const written = await emitDeclarations(root, compiledDir, exposed, sources);
    if (!written.length) return null;
    const base = commonDir([...Object.values(exposed), ...sources.filter((f) => /\.(m|c)?tsx?$/.test(f) && fs.existsSync(f))].map((f) => path.dirname(real(f))));
    const keys: string[] = [];
    for (const [key, file] of Object.entries(exposed)) {
        const rel = path.relative(base, real(file)).replace(/\.(m|c)?tsx?$/, '').split(path.sep).join('/');
        const declared = written.find((w) => w.replace(/\.d\.[mc]?ts$/, '') === rel);
        if (!declared) continue;
        const name = key === '.' ? 'index' : key.replace(/^\.\//, '');
        const entry = path.join(typesDir, `${name}.d.ts`);
        const spec = `./${path.posix.relative(path.posix.dirname(name), `${COMPILED}/${rel}`)}`.replace(/^\.\/\.\.\//, '../');
        let stub = `export * from ${JSON.stringify(spec)};\n`;
        if (/\bexport\s+default\b|\bas\s+default\b/.test(fs.readFileSync(path.join(compiledDir, declared), 'utf8'))) stub += `export { default } from ${JSON.stringify(spec)};\n`;
        await fsp.mkdir(path.dirname(entry), { recursive: true });
        await fsp.writeFile(entry, stub);
        keys.push(path.posix.join('REMOTE_ALIAS_IDENTIFIER', name === 'index' ? '' : name));
    }
    // `loadRemote('remote/Button')` typing, as the dts plugin's API file.
    const api = `export type RemoteKeys = ${keys.map((k) => `'${k}'`).join(' | ') || 'never'};\ntype PackageType<T> = ${keys.map((k) => `T extends '${k}' ? typeof import('${k}') :`).join(' ')} any;\n`;
    await fsp.writeFile(path.join(outDir, `${TYPES_FOLDER}.d.ts`), api);
    await fsp.writeFile(path.join(outDir, `${TYPES_FOLDER}.zip`), zipDir(typesDir));
    return [`${TYPES_FOLDER}.zip`, `${TYPES_FOLDER}.d.ts`];
}

/** A host: each remote's types into `@mf-types/<remote>/`. Returns the remotes whose types arrived. */
export async function consumeRemoteTypes(root: string, options: FederationOptions, timeoutMs = 5000): Promise<string[]> {
    const remotes = Object.entries(options.remotes ?? {});
    if (!remotes.length || !['tsconfig.json', 'jsconfig.json'].some((f) => fs.existsSync(path.join(root, f)))) return [];
    const typesRoot = path.join(root, TYPES_FOLDER);
    const got: string[] = [];
    await Promise.all(remotes.map(async ([alias, spec]) => {
        const at = /^[A-Za-z0-9_$.-]+@(.+)$/.exec(spec);
        const entryUrl = at ? at[1]! : spec;
        if (!/^https?:\/\//.test(entryUrl)) return;
        const zipUrl = new URL(`${TYPES_FOLDER}.zip`, entryUrl).href;
        try {
            const res = await fetch(zipUrl, { signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) return;
            const dest = path.join(typesRoot, alias);
            await fsp.rm(dest, { recursive: true, force: true });
            unzip(Buffer.from(await res.arrayBuffer()), dest);
            const api = await fetch(new URL(`${TYPES_FOLDER}.d.ts`, entryUrl).href, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
            if (api?.ok) await fsp.writeFile(path.join(dest, 'apis.d.ts'), (await api.text()).replaceAll('REMOTE_ALIAS_IDENTIFIER', alias));
            got.push(alias);
        } catch {
            // The remote is not running or has no types: the host builds without them.
        }
    }));
    if (got.length && !mapsTypesFolder(root)) {
        console.warn(`[lunx mf] types for ${got.join(', ')} are in ${TYPES_FOLDER}/. For TypeScript to use them, add to tsconfig.json compilerOptions: "paths": { "*": ["./${TYPES_FOLDER}/*"] }`);
    }
    return got;
}

/** The files and every relative module they import (`import type` included), transitively. */
function typeClosure(files: string[]): string[] {
    const seen = new Set<string>();
    const queue = files.filter((f) => fs.existsSync(f));
    while (queue.length) {
        const file = queue.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const code = fs.readFileSync(file, 'utf8');
        for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g)) {
            const target = resolveSource(path.resolve(path.dirname(file), m[2]!.replace(/\.js$/, '')));
            if (target && /\.(m|c)?tsx?$/.test(target) && !target.endsWith('.d.ts') && !seen.has(target)) queue.push(target);
        }
    }
    return [...seen];
}

/** Whether the project's tsconfig maps imports to @mf-types/ (as the dts plugin's hosts do). */
function mapsTypesFolder(root: string): boolean {
    try {
        return fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8').includes(TYPES_FOLDER);
    } catch {
        return false;
    }
}

function resolveSource(file: string): string | null {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    for (const ext of ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']) if (fs.existsSync(file + ext)) return file + ext;
    return null;
}

function real(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        return file;
    }
}

function commonDir(dirs: string[]): string {
    let common = dirs[0]!;
    for (const d of dirs.slice(1)) while (common !== path.dirname(common) && path.relative(common, d).startsWith('..')) common = path.dirname(common);
    return common;
}

// ── zip (deflate), enough for a folder of .d.ts files ─────────────────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

export function zipDir(dir: string): Buffer {
    const files = (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => f.split(path.sep).join('/')).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const name of files) {
        const data = fs.readFileSync(path.join(dir, name));
        const packed = zlib.deflateRawSync(data);
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, packed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);
        offset += 30 + nameBuf.length + packed.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

/** Extract a zip (stored or deflated entries) into `dest`, refusing paths that leave it. */
export function unzip(zip: Buffer, dest: string): void {
    let eocd = zip.length - 22;
    while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) throw new Error('not a zip file');
    const count = zip.readUInt16LE(eocd + 10);
    let p = zip.readUInt32LE(eocd + 16);
    for (let i = 0; i < count; i++) {
        if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
        const method = zip.readUInt16LE(p + 10);
        const size = zip.readUInt32LE(p + 20);
        const nameLen = zip.readUInt16LE(p + 28);
        const extraLen = zip.readUInt16LE(p + 30);
        const commentLen = zip.readUInt16LE(p + 32);
        const localOffset = zip.readUInt32LE(p + 42);
        const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;
        if (name.endsWith('/')) continue;
        const target = path.resolve(dest, name);
        if (!target.startsWith(path.resolve(dest) + path.sep)) throw new Error(`zip entry escapes the destination: ${name}`);
        const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
        const raw = zip.subarray(start, start + size);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, method === 8 ? zlib.inflateRawSync(raw) : raw);
    }
}
