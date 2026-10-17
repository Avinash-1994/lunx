/**
 * Finds and loads lunx's Rust N-API binding, without side effects: the engine
 * (./index.ts) logs which one it uses and falls back to JS; the production
 * build's CommonJS lexer (build/cjs-lexer.ts) only wants it when it is there.
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function looksLikeNativeBinding(mod: any): boolean {
    if (!mod || typeof mod !== 'object') return false;
    if (typeof mod.helloRust !== 'function') return false;
    try {
        return String(mod.helloRust()) !== 'JS fallback';
    } catch {
        return false;
    }
}

function platformNativeName(): string {
    const { platform, arch } = process;
    // Mirror napi-rs binary naming (gnu linux is the common CI/publish target).
    if (platform === 'linux' && arch === 'x64') return 'lunx_native.linux-x64-gnu.node';
    if (platform === 'linux' && arch === 'arm64') return 'lunx_native.linux-arm64-gnu.node';
    if (platform === 'darwin' && arch === 'x64') return 'lunx_native.darwin-x64.node';
    if (platform === 'darwin' && arch === 'arm64') return 'lunx_native.darwin-arm64.node';
    if (platform === 'win32' && arch === 'x64') return 'lunx_native.win32-x64-msvc.node';
    return 'lunx_native.node';
}

function platformOptionalPackage(): string | null {
    const { platform, arch } = process;
    if (platform === 'linux' && arch === 'x64') return '@lunx/native-linux-x64-gnu';
    if (platform === 'linux' && arch === 'arm64') return '@lunx/native-linux-arm64-gnu';
    if (platform === 'darwin' && arch === 'arm64') return '@lunx/native-darwin-arm64';
    if (platform === 'darwin' && arch === 'x64') return '@lunx/native-darwin-x64';
    if (platform === 'win32' && arch === 'x64') return '@lunx/native-win32-x64-msvc';
    return null;
}

function tryLoadOptionalNativePackage(): any | null {
    const pkgName = platformOptionalPackage();
    if (!pkgName) return null;
    try {
        const loaded = _require(pkgName);
        if (looksLikeNativeBinding(loaded)) return loaded;
    } catch {
        // optionalDependency may be missing on unsupported platforms — OK
    }
    // Monorepo / pre-publish: packages/lunx-native-* next to the tool root
    try {
        const short = pkgName.replace('@lunx/', '');
        const candidates = [
            path.resolve(__dirname, `../../../packages/${short}/index.js`),
            path.resolve(__dirname, `../../packages/${short}/index.js`),
            path.resolve(process.cwd(), `packages/${short}/index.js`),
            path.resolve(process.cwd(), `node_modules/${pkgName}/index.js`),
        ];
        for (const c of candidates) {
            if (!fs.existsSync(c)) continue;
            const loaded = _require(c);
            if (looksLikeNativeBinding(loaded)) return loaded;
        }
    } catch { /* ignore */ }
    return null;
}

let found: { binding: any; error: unknown } | undefined;

/** The binding (null when none loads) and, if one was found but failed, why. */
export function loadNativeBinding(): { binding: any; error: unknown } {
    if (found) return found;
    // 1) Preferred: optional platform package (keeps lunx-dev ≤1.6MB on npm)
    const fromOptional = tryLoadOptionalNativePackage();
    if (fromOptional) return (found = { binding: fromOptional, error: null });

    // 2) Local/dev fallback: lunx_native.node beside the repo (cargo build)
    const searchRoots = [
        __dirname,
        path.resolve(__dirname, '..'),
        path.resolve(__dirname, '../..'),
        path.resolve(__dirname, '../../..'),
        path.resolve(__dirname, '../../../native'),
        path.resolve(__dirname, '../../native'),
        path.resolve(__dirname, '../native'),
        process.cwd(),
        path.resolve(process.cwd(), 'dist'),
        path.resolve(process.cwd(), 'dist/native'),
        path.resolve(process.cwd(), 'native'),
    ];
    const platName = platformNativeName();
    let error: unknown = null;
    for (const root of searchRoots) {
        for (const c of [path.join(root, 'lunx_native.node'), path.join(root, platName)]) {
            if (!fs.existsSync(c)) continue;
            try {
                const loaded = _require(c);
                if (looksLikeNativeBinding(loaded)) return (found = { binding: loaded, error: null });
                error = new Error(`${c} loaded but is not the Rust N-API binding`);
            } catch (err) {
                error = err;
            }
        }
    }
    return (found = { binding: null, error });
}
