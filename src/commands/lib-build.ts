/**
 * src/commands/lib-build.ts
 *
 * The original programmatic library API (`buildLib`), kept for existing
 * callers. Library builds run in src/build/library.ts, which `lunx build --lib`
 * and `lib` in lunx.config use too.
 */

import path from 'path'
import type { BuildConfig } from '../config/index.js'

export interface LunxLibConfig {
  entry: string
  name?: string
  formats?: string[]
  externals?: string[]
  fileName?: string | ((format: string) => string)
}

export interface LibBuildResult {
  outputs: { file: string; format: string; size: number }[]
  durationMs: number
}

export async function buildLib(config: BuildConfig, lib: LunxLibConfig): Promise<LibBuildResult> {
  const { buildLibrary } = await import('../build/library.js')
  const root = config.root ?? process.cwd()
  const result = await buildLibrary(root, {
    entry: lib.entry,
    name: lib.name,
    formats: lib.formats as any,
    fileName: typeof lib.fileName === 'function' ? (format) => (lib.fileName as (f: string) => string)(format).replace(/\.[^.]+$/, '') : lib.fileName,
    external: lib.externals,
    outDir: config.outDir ?? 'build_output',
    minify: config.build?.minify ?? undefined,
    sourcemap: config.build?.sourcemap === 'external' || config.build?.sourcemap === 'inline',
  }, config.framework)
  const outDir = path.resolve(root, config.outDir ?? 'build_output')
  return {
    outputs: result.files.filter((f) => f.format !== 'dts' && f.format !== 'css').map((f) => ({ file: path.join(outDir, f.file), format: f.format, size: f.size })),
    durationMs: result.durationMs,
  }
}
