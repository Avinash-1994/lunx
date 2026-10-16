/**
 * `build.polyfill` (Rsbuild's `output.polyfill`): core-js polyfills for the
 * build's browser targets (src/build/targets.ts), from the project's own
 * core-js.
 *
 *  - 'entry': every polyfill the targets need, imported first by each entry
 *    (needs `core-js` and `core-js-compat`);
 *  - 'usage': only those the app's code uses, added where it uses them (needs
 *    `core-js`, `@babel/core` and `babel-plugin-polyfill-corejs3`).
 *
 * Syntax is lowered separately (`build.target`); browsers without ES modules
 * are not supported (as in Vite without @vitejs/plugin-legacy).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export type PolyfillMode = 'entry' | 'usage' | 'off' | false | undefined;

export const POLYFILLS_ID = 'lunx:polyfills';

/** core-js-compat's target names for lunx's (Oxc) ones; ES versions say nothing about browsers. */
function compatTargets(targets: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of targets) {
        const m = /^([a-z]+)(\d+(?:\.\d+){0,2})$/.exec(t);
        if (!m || m[1] === 'es') continue;
        const name = m[1]!;
        if (!out[name] || compare(m[2]!, out[name]!) < 0) out[name] = m[2]!;
    }
    return out;
}

const compare = (a: string, b: string) => {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
};

function coreJsVersion(req: NodeRequire): string {
    const file = req.resolve('core-js/package.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

const install = (what: string) => new Error(`build.polyfill needs ${what}: npm install -D ${what}`);

/** 'entry': the polyfill module's code (one import per core-js module the targets need). */
export function entryPolyfills(root: string, targets: string[] | null): string {
    const req = createRequire(path.join(root, 'package.json'));
    let compat: any;
    try {
        req.resolve('core-js/package.json');
        compat = req('core-js-compat');
    } catch {
        throw install('core-js core-js-compat');
    }
    const t = compatTargets(targets ?? []);
    const { list } = compat({ targets: Object.keys(t).length ? t : { esmodules: true }, modules: ['core-js/stable'], version: coreJsVersion(req) });
    return (list as string[]).map((name) => `import ${JSON.stringify(`core-js/modules/${name}.js`)};`).join('\n') + '\n';
}

export interface UsagePolyfiller {
    transform(file: string, code: string): Promise<{ code: string; map: any } | null>;
}

/** 'usage': a transform adding the polyfills each module uses. */
export function usagePolyfiller(root: string, targets: string[] | null): UsagePolyfiller {
    const req = createRequire(path.join(root, 'package.json'));
    let babel: any;
    let plugin: any;
    let version: string;
    try {
        version = coreJsVersion(req);
        babel = req('@babel/core');
        const mod = req('babel-plugin-polyfill-corejs3');
        plugin = mod.default ?? mod;
    } catch {
        throw install('core-js @babel/core babel-plugin-polyfill-corejs3');
    }
    const t = compatTargets(targets ?? []);
    return {
        async transform(file, code) {
            const ts = /\.[mc]?tsx?$/.test(file);
            const result = await babel.transformAsync(code, {
                filename: file,
                babelrc: false,
                configFile: false,
                sourceMaps: true,
                sourceType: 'module', // app sources are ES modules: the polyfills are imports, not require()s
                parserOpts: { plugins: ['jsx', ...(ts ? ['typescript'] : [])] },
                plugins: [[plugin, { method: 'usage-global', version, targets: Object.keys(t).length ? t : { esmodules: true } }]],
            });
            if (!result?.code || result.code === code) return null;
            return { code: result.code, map: result.map };
        },
    };
}
