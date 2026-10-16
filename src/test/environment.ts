/**
 * Test environments for `lunx test`: 'node' (default), 'jsdom' or
 * 'happy-dom' (the project's package), chosen by `--environment`,
 * `test.environment` in lunx.config, or a file's docblock
 * (`@vitest-environment jsdom`, `@jest-environment jsdom`, `@lunx-environment jsdom`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export type Environment = 'node' | 'jsdom' | 'happy-dom';

const DOCBLOCK = /@(?:vitest|jest|lunx)-environment\s+([\w-]+)/;

export function environmentOf(file: string, fallback: Environment): Environment {
    try {
        const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
        const m = DOCBLOCK.exec(head);
        if (m && (m[1] === 'node' || m[1] === 'jsdom' || m[1] === 'happy-dom')) return m[1];
    } catch {
        // unreadable: the runner reports it when importing
    }
    return fallback;
}

/** Installs the environment's globals; returns the teardown. */
export async function setupEnvironment(env: Environment, root: string): Promise<() => void> {
    if (env === 'node') return () => {};
    const req = createRequire(path.join(root, 'package.json'));
    let window: any;
    let close: () => void;
    try {
        if (env === 'jsdom') {
            const { JSDOM } = req('jsdom');
            const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url: 'http://localhost:3000/', pretendToBeVisual: true });
            window = dom.window;
            close = () => dom.window.close();
        } else {
            const { Window } = req('happy-dom');
            window = new Window({ url: 'http://localhost:3000/' });
            close = () => window.happyDOM?.abort?.() ?? window.close?.();
        }
    } catch (err: any) {
        if (err?.code === 'MODULE_NOT_FOUND') throw new Error(`the ${env} environment needs ${env} installed: npm install -D ${env}`);
        throw err;
    }
    const g = globalThis as any;
    const saved = new Map<string, PropertyDescriptor | undefined>();
    const keys = new Set([...Object.getOwnPropertyNames(window), ...Object.getOwnPropertyNames(Object.getPrototypeOf(window) ?? {})]);
    for (const key of keys) {
        if (key in g && !['document', 'window', 'navigator', 'location', 'self', 'localStorage', 'sessionStorage'].includes(key) && !/^(HTML|SVG|Element|Node|Event|Document|Text|Comment|DOM|CSS|Mutation|Intersection|Resize|Custom|Shadow|Range|Selection|KeyboardEvent|MouseEvent)/.test(key)) continue;
        if (/^_|^(globalThis|global|undefined|NaN|Infinity|eval|constructor)$/.test(key)) continue;
        saved.set(key, Object.getOwnPropertyDescriptor(g, key));
        try {
            // Functions (addEventListener, getComputedStyle…) run with the window as `this`.
            let bound: { from: unknown; to: unknown } | null = null;
            const get = () => {
                if (key === 'window' || key === 'self') return g;
                const v = window[key];
                if (typeof v !== 'function' || !/^[a-z]/.test(key)) return v;
                if (bound?.from !== v) bound = { from: v, to: v.bind(window) };
                return bound!.to;
            };
            Object.defineProperty(g, key, { configurable: true, enumerable: true, get, set: (v) => {
                window[key] = v;
            } });
        } catch {
            saved.delete(key);
        }
    }
    return () => {
        for (const [key, desc] of saved) {
            try {
                if (desc) Object.defineProperty(g, key, desc);
                else delete g[key];
            } catch {
                // a non-configurable global: leave it
            }
        }
        close();
    };
}
