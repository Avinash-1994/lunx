/**
 * src/commands/lib-build.ts
 *
 * Library mode — builds lunx projects as npm packages.
 * Produces ES + CJS + UMD/IIFE outputs with proper externals.
 *
 * Wire into cli.ts build command:
 *   if (config.lib) await buildLib(config)
 *   else await buildApp(config)  // your existing build
 */

import path from 'path'
import fs from 'fs'
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

const FORMAT_EXTENSIONS: Record<string, string> = {
  es: '.mjs',
  cjs: '.cjs',
  umd: '.umd.js',
  iife: '.iife.js',
}

function resolveFileName(
  lib: LunxLibConfig,
  format: string
): string {
  if (typeof lib.fileName === 'function') {
    return lib.fileName(format)
  }
  if (typeof lib.fileName === 'string') {
    return `${lib.fileName}${FORMAT_EXTENSIONS[format] ?? '.js'}`
  }
  // Default: derive from entry file name
  const base = path.basename(lib.entry, path.extname(lib.entry))
  return `${base}${FORMAT_EXTENSIONS[format] ?? '.js'}`
}

export async function buildLib(config: BuildConfig, lib: LunxLibConfig): Promise<LibBuildResult> {
  const outDir = path.resolve(process.cwd(), config.outDir ?? 'build_output')
  const formats = lib.formats ?? ['es', 'cjs']
  const externals = lib.externals ?? []

  // Auto-detect externals from peerDependencies in package.json
  const pkgPath = path.join(process.cwd(), 'package.json')
  const autoExternals: string[] = [...externals]
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const peers = Object.keys(pkg.peerDependencies ?? {})
    const deps = Object.keys(pkg.dependencies ?? {})
    // Externalize peers and deps (don't bundle them)
    autoExternals.push(...peers, ...deps)
  }

  // Deduplicate
  const uniqueExternals = [...new Set(autoExternals)]

  const startTime = Date.now()
  const outputs: LibBuildResult['outputs'] = []

  // Build each format
  for (const format of formats) {
    const outFile = path.join(outDir, resolveFileName(lib, format))

    // Real UMD (not an iife stand-in) and the same tree shaking as app
    // builds; externals match exact names and subpaths.
    const { getBundler } = await import('../engines/index.js')
    const isExternal = (id: string) => uniqueExternals.some((e) => id === e || id.startsWith(e + '/')) || id.startsWith('node:')
    await getBundler().bundle({
      input: path.resolve(process.cwd(), lib.entry),
      platform: format === 'cjs' ? 'node' : 'browser',
      quiet: true,
      external: isExternal,
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    }, {
      file: outFile,
      format: format as 'es' | 'cjs' | 'iife' | 'umd',
      name: format === 'umd' || format === 'iife' ? lib.name : undefined,
      minify: config.build?.minify ?? true,
      sourcemap: (config.build?.sourcemap === 'external' || config.build?.sourcemap === 'inline') ? true : false,
      inlineDynamicImports: true,
    }, true)

    const size = fs.statSync(outFile).size
    outputs.push({ file: outFile, format, size })

    console.log(
      `  ✅ ${format.padEnd(4)} → ${path.relative(process.cwd(), outFile)} ` +
        `(${(size / 1024).toFixed(1)} kB)`
    )
  }

  // Generate TypeScript declarations if tsconfig present
  const tsConfig = path.join(process.cwd(), 'tsconfig.json')
  if (fs.existsSync(tsConfig)) {
    await generateDts(lib, outDir)
  }

  // Generate package.json exports field suggestion
  printExportsAdvice(lib, formats, outDir, config.outDir ?? 'build_output')

  return {
    outputs,
    durationMs: Date.now() - startTime,
  }
}

async function generateDts(lib: LunxLibConfig, outDir: string): Promise<void> {
  try {
    // Use tsc if available
    const { execSync } = await import('child_process')

    execSync(
      `npx tsc --declaration --declarationDir ${outDir} --emitDeclarationOnly --noEmit false`,
      { stdio: 'pipe' }
    )
    console.log(`  ✅ dts  → ${path.relative(process.cwd(), outDir)}/*.d.ts`)
  } catch {
    // tsc not available or failed — skip silently
  }
}

function printExportsAdvice(
  lib: LunxLibConfig,
  formats: string[],
  outDir: string,
  outDirName: string
): void {
  const base = path.basename(lib.entry, path.extname(lib.entry))

  const exports: Record<string, unknown> = { '.': {} }
  const exportsField = exports['.'] as Record<string, string>

  if (formats.includes('es')) {
    exportsField['import'] = `./${outDirName}/${base}.mjs`
  }
  if (formats.includes('cjs')) {
    exportsField['require'] = `./${outDirName}/${base}.cjs`
    exportsField['default'] = `./${outDirName}/${base}.cjs`
  }

  const advice: Record<string, unknown> = {
    main: formats.includes('cjs') ? `./${outDirName}/${base}.cjs` : `./${outDirName}/${base}.mjs`,
    module: formats.includes('es') ? `./${outDirName}/${base}.mjs` : undefined,
    types: `./${outDirName}/index.d.ts`,
    exports,
  }

  console.log('\n  💡 Add to package.json:')
  console.log(JSON.stringify(advice, null, 2).split('\n').map(l => '  ' + l).join('\n'))
}
