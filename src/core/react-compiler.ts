/**
 * The React Compiler (automatic memoization) on the app's components, in dev
 * and builds: the project's `babel-plugin-react-compiler`, run through its
 * `@babel/core` before lunx compiles JSX and TypeScript.
 *
 * On when the plugin is installed (or with `react: { compiler: true }`);
 * `react: { compiler: false }` turns it off, and `react: { compiler: { target: '18' } }`
 * passes options to it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export interface ReactCompilerConfig {
    compiler?: boolean | Record<string, unknown>;
}

interface Loaded {
    babel: any;
    plugin: any;
    options: Record<string, unknown>;
}

const loaded = new Map<string, Loaded | null>();

/** The compiler for this project, or null (not installed / turned off). Throws if asked for and missing. */
export function reactCompiler(root: string, config: ReactCompilerConfig | undefined): Loaded | null {
    const setting = config?.compiler;
    if (setting === false) return null;
    const key = `${root}\0${JSON.stringify(setting ?? null)}`;
    if (loaded.has(key)) return loaded.get(key)!;
    const req = createRequire(path.join(root, 'package.json'));
    let result: Loaded | null = null;
    try {
        const pluginPath = req.resolve('babel-plugin-react-compiler');
        const babel = req('@babel/core');
        const mod = req(pluginPath);
        result = { babel, plugin: mod.default ?? mod, options: typeof setting === 'object' && setting ? setting : {} };
    } catch {
        if (setting) throw new Error('react.compiler needs babel-plugin-react-compiler and @babel/core: npm install -D babel-plugin-react-compiler @babel/core');
    }
    loaded.set(key, result);
    return result;
}

/** Whether a source may hold components or hooks worth compiling. */
export function mayHaveComponents(file: string, code: string): boolean {
    return /\.[jt]sx$/.test(file) || (/\.[mc]?[jt]s$/.test(file) && /\buse[A-Z]\w*\s*\(/.test(code));
}

/** `code` with components and hooks memoized; JSX and TypeScript are left for lunx's compiler. */
export async function compileReact(compiler: Loaded, file: string, code: string): Promise<{ code: string; map: any } | null> {
    if (!/\b(?:function|=>)/.test(code)) return null;
    const ts = /\.[mc]?tsx?$/.test(file);
    const result = await compiler.babel.transformAsync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        parserOpts: { plugins: ['jsx', ...(ts ? ['typescript'] : [])] },
        plugins: [[compiler.plugin, compiler.options]],
    });
    if (!result?.code || result.code === code) return null;
    return { code: result.code, map: result.map };
}

/** Whether the project's dependencies name the compiler (cheap check before resolving it). */
export function declaresReactCompiler(root: string): boolean {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        return 'babel-plugin-react-compiler' in { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
        return false;
    }
}
