import fs from 'fs'
import path from 'path'

export interface EnvConfig {
  /** Variables with these prefixes reach client code. Default: LUNX_, VITE_, REACT_APP_, PUBLIC_ */
  prefix?: string | string[]
  files?: string[]
}

export interface LoadedEnv {
  /** All env vars (raw process.env + loaded files) */
  raw: Record<string, string>
  /** Only vars matching the prefix, ready for esbuild define */
  define: Record<string, string>
  /** import.meta.env defines */
  metaEnv: Record<string, string>
}

/**
 * Parse a .env file into a key/value map.
 * Supports:
 *   - Comments (#)
 *   - Quoted values ("value" or 'value')
 *   - Multiline values with \n
 *   - Variable expansion ($VAR or ${VAR})
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    // Skip comments and empty lines
    if (!line || line.startsWith('#')) continue

    // Find = sign
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) continue

    const key = line.slice(0, eqIndex).trim()
    let value = line.slice(eqIndex + 1).trim()

    // Strip inline comments (but not inside quotes)
    // Remove surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
    } else {
      // Strip inline comment
      const commentIdx = value.indexOf(' #')
      if (commentIdx !== -1) {
        value = value.slice(0, commentIdx).trim()
      }
    }

    if (key) {
      result[key] = value
    }
  }

  return result
}

/**
 * Load env files in priority order (later = higher priority).
 * Matches Vite's env loading strategy.
 */
export function loadEnv(
  mode: 'development' | 'production' | 'test',
  root: string,
  config: EnvConfig = {}
): LoadedEnv {
  // VITE_ and REACT_APP_ are accepted so Vite and CRA apps work unchanged;
  // every one of these prefixes means "public" in its own ecosystem.
  const prefixes = ([] as string[]).concat(config.prefix ?? ['LUNX_', 'VITE_', 'REACT_APP_', 'PUBLIC_'])

  // Files to load in order (later files override earlier ones)
  const defaultFiles = [
    '.env',                    // always loaded
    `.env.local`,              // local overrides (git-ignored)
    `.env.${mode}`,            // mode-specific
    `.env.${mode}.local`,      // mode-specific local overrides
  ]

  const filesToLoad = config.files ?? defaultFiles
  const loaded: Record<string, string> = {}

  for (const file of filesToLoad) {
    const filePath = path.resolve(root, file)
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const parsed = parseEnvFile(content)
        Object.assign(loaded, parsed)
      } catch (err) {
        console.warn(`[lunx] Warning: Could not read ${file}:`, err)
      }
    }
  }

  // Merge: process.env takes lowest priority (except for LUNX_ vars)
  const raw: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...loaded,
  }

  // Filter to only prefix-matching vars + standard vars
  const ALWAYS_EXPOSE = new Set(['NODE_ENV', 'MODE', 'DEV', 'PROD', 'SSR'])

  const clientVars: Record<string, string | boolean> = {}

  for (const [key, value] of Object.entries(raw)) {
    if (prefixes.some((p) => key.startsWith(p)) || ALWAYS_EXPOSE.has(key)) {
      clientVars[key] = value ?? ''
    }
  }

  // Add synthetic vars
  clientVars['MODE'] = mode
  // Booleans, not strings: `if (import.meta.env.DEV)` must be false in a
  // production build, and the string "false" is truthy.
  clientVars['DEV'] = mode !== 'production'
  clientVars['PROD'] = mode === 'production'
  clientVars['SSR'] = false

  // Build esbuild `define` object
  // `process.env.X` → stringified value
  const define: Record<string, string> = {}
  // `import.meta.env.X` → stringified value
  const metaEnv: Record<string, string> = {}

  for (const [key, value] of Object.entries(clientVars)) {
    const stringified = JSON.stringify(value)
    define[`process.env.${key}`] = stringified
    metaEnv[`import.meta.env.${key}`] = stringified
  }

  // Also expose the full import.meta.env object
  const metaEnvObject = JSON.stringify(clientVars)
  define['import.meta.env'] = metaEnvObject

  return { raw, define, metaEnv }
}

/**
 * Get all define entries for esbuild (combines process.env + import.meta.env)
 */
export function getEsbuildDefines(env: LoadedEnv): Record<string, string> {
  return {
    ...env.define,
    ...env.metaEnv,
  }
}

/**
 * Validate that sensitive env vars aren't accidentally exposed.
 * Warns if a non-prefixed var looks sensitive.
 */
export function warnSensitiveEnv(
  env: LoadedEnv,
  prefix: string = 'LUNX_'
): void {
  const SENSITIVE_PATTERNS = [
    /secret/i,
    /password/i,
    /private_key/i,
    /api_key/i,
    /token/i,
    /auth/i,
  ]

  for (const key of Object.keys(env.raw)) {
    if (!key.startsWith(prefix)) continue
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(key)) {
        console.warn(
          `[lunx] ⚠️  Warning: "${key}" matches a sensitive pattern and will be exposed to the client bundle. ` +
          `Make sure this is intentional.`
        )
        break
      }
    }
  }
}
