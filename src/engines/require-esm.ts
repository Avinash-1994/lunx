/**
 * Loads the engine's ES modules with require() (Node >= 20.19 runs ES modules
 * that way) instead of a top-level await, so CommonJS tools can require()
 * lunx modules that use the engine — Remix requires `vite-node/server`, for
 * instance. Node's own `module` is used even under test runners that replace
 * `require` with one that cannot load ES modules.
 */

import { createRequire } from 'node:module';

const nodeModule: typeof import('node:module') = (process as any).getBuiltinModule?.('node:module') ?? { createRequire };

export const requireEsm: (id: string) => any = nodeModule.createRequire(import.meta.url);
