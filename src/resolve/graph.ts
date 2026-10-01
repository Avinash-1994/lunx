import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
import { canonicalHash } from '../core/engine/hash.js';
import { normalizePath, generateModuleId } from './utils.js';
import fs from 'fs/promises';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { PluginManager } from '../core/plugins/manager.js';
import { scanImports } from '../native/index.js';
import { log } from '../utils/logger.js';

export type GraphEdgeKind = 'import' | 'dynamic-import' | 'require' | 'css-url' | 'css-import' | 'js-style-import' | 'css-layer';

export type CSSImportPrecedence = {
  specificity: number;
  sourceOrder: number;
  cascadeLayer?: string;
};

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  loc?: any;
  metadata?: any;
  target?: 'client' | 'server' | 'edge' | 'universal';
}

export interface GraphNode {
  id: string;
  type: 'file' | 'virtual' | 'css' | 'css-module' | 'style-asset' | 'css-in-js';
  path: string;
  contentHash: string;
  edges: GraphEdge[];
  specifierMap?: Record<string, string>;
  metadata?: Record<string, any>;
  target?: 'client' | 'server' | 'edge' | 'universal';
  cssInJs?: {
    runtime: "styled-components" | "emotion" | "linaria";
    extractedCss: string;
  };
}

export interface GraphValidation {
  isValid: boolean;
  cycles: string[][];
  errors: string[];
}

export class DependencyGraph {
  nodes = new Map<string, GraphNode>();
  graphHash: string = '';
  private pluginManager: PluginManager | null = null;

  constructor(pluginManager?: PluginManager) {
    this.pluginManager = pluginManager || null;
  }

  async addEntry(entryPath: string, rootDir: string) {
    if (entryPath.toLowerCase().split(/[?#]/)[0].endsWith('.html')) {
      return;
    }
    const normalized = normalizePath(entryPath);
    const type = this.detectType(normalized);
    const id = generateModuleId(type, normalized, rootDir);

    const queue = [{ id, type, absPath: normalized }];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const currentBatch = queue.splice(0, 100);
      await Promise.all(currentBatch.map(async (item) => {
        if (visited.has(item.id)) return;
        visited.add(item.id);

        const newDeps = await this.scanAndAdd(item.id, item.type, item.absPath, rootDir);
        for (const dep of newDeps) {
          if (!visited.has(dep.id)) {
            queue.push(dep);
          }
        }
      }));
    }
  }

  private detectType(p: string): GraphNode['type'] {
    if (p.endsWith('.module.css')) return 'css-module';
    if (p.endsWith('.css')) return 'css';
    if (p.endsWith('.vue')) return 'file';
    if (p.endsWith('.svelte')) return 'file';
    if (p.endsWith('.astro')) return 'file';
    const ext = path.extname(p).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.woff', '.woff2', '.ttf'].includes(ext)) {
      return 'style-asset';
    }
    return 'file';
  }

  private async scanAndAdd(id: string, type: GraphNode['type'], absPath: string, rootDir: string): Promise<{ id: string, type: GraphNode['type'], absPath: string }[]> {
    if (this.nodes.has(id)) return [];

    const node: GraphNode = {
      id,
      type,
      path: absPath,
      contentHash: '', // Set after loading
      edges: [],
      metadata: {},
      specifierMap: {},
      target: 'universal'
    };

    // Use Plugin Manager to load content if available (supports assets, etc.)
    let content: string = '';
    if (this.pluginManager) {
      const loadResult = await this.pluginManager.runHook('load', { id, path: absPath }, { rootDir });
      if (loadResult && loadResult.code !== undefined) {
        content = loadResult.code;
      }
    }

    if (!content) {
      try {
        content = await fs.readFile(absPath, 'utf-8');
      } catch (e) {
        return [];
      }
    }

    // NEW: Transform Specialty Files so we can scan their imports correctly
    if (this.pluginManager && (absPath.endsWith('.vue') || absPath.endsWith('.svelte') || absPath.endsWith('.astro'))) {
      const transformResult = await this.pluginManager.runHook('transformModule', {
        code: content,
        path: absPath,
        id,
        mode: 'development' // Use dev mode for scanning
      }, { rootDir });
      if (transformResult && transformResult.code) {
        content = transformResult.code;
      }
    }

    node.contentHash = canonicalHash(content);

    const imports = await this.parseImportsSimple(content, absPath, rootDir);
    const discovered: { id: string, type: GraphNode['type'], absPath: string }[] = [];

    for (const imp of imports) {
      const depType = this.detectType(imp.resolved);
      const depId = generateModuleId(depType, imp.resolved, rootDir);

      node.edges.push({
        from: id,
        to: depId,
        kind: imp.kind as any,
        target: 'universal'
      });

      // Populate specifierMap for the Linker plugin
      if (node.specifierMap) {
        node.specifierMap[imp.original] = depId;
      }

      discovered.push({ id: depId, type: depType, absPath: imp.resolved });
    }

    this.nodes.set(id, node);
    return discovered;
  }

  private async parseImportsSimple(content: string, filePath: string, rootDir?: string): Promise<{ original: string, resolved: string, kind: string }[]> {
    const ext = path.extname(filePath);
    if (!['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro'].includes(ext)) return [];

    let specifiers: string[] = [];
    try {
      // Filter out obvious noise from native scanner
      specifiers = scanImports(content).filter((s: string) =>
        s && s.length > 0 &&
        !s.includes(' ') &&
        s !== 'specifier' &&
        s !== '...' &&
        !s.includes('${') &&
        !s.includes('`')
      );
    } catch (e) {
      // ignore
    }

    // Minified ESM has no whitespace after the keyword -- `import"lit-html";`
    // and `export*from"./x.js"` are both legal. Patterns that required
    // `import\s+` silently saw no imports at all in published packages, so
    // their dependencies never reached the graph and the bundle shipped
    // unresolved bare specifiers.
    const discoveredSpecifiers: string[] = [...specifiers];
    const addSpecifier = (value: string | undefined) => {
      if (!value || value.includes(' ') || value.length >= 500) return;
      if (!discoveredSpecifiers.includes(value)) discoveredSpecifiers.push(value);
    };
    // import x from"y" / export*from"y" / export{a}from"y"
    for (const m of content.matchAll(/from\s*['"]([^'"]+)['"]/g)) addSpecifier(m[1]);
    // side-effect: import"y"
    for (const m of content.matchAll(/import\s*['"]([^'"]+)['"]/g)) addSpecifier(m[1]);
    // dynamic: import("y")
    for (const m of content.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) addSpecifier(m[1]);
    // cjs: require("y")
    for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) addSpecifier(m[1]);
    specifiers = discoveredSpecifiers;

    const results: { original: string, resolved: string, kind: string }[] = [];
    for (const s of specifiers) {
      const resolved = await this.resolve(s, filePath);
      if (resolved) {
        results.push({ original: s, resolved, kind: 'import' });
      } else {
        // PRODUCTION NOISE REDUCTION:
        // 1. Only warn if the file is in the project's root source
        // 2. Ignore lunx internal paths and node_modules
        const isProjectFile = rootDir ? filePath.startsWith(rootDir) : !filePath.includes('node_modules');
        const isInternalFile = filePath.includes('/build/dist/') || filePath.includes('/build/src/') || filePath.includes('/build/native/');

        if (isProjectFile && !isInternalFile && !filePath.includes('node_modules')) {
          // Only warn for relatively clear "missing project file" cases (relative paths)
          if (s.startsWith('.') || s.startsWith('@/')) {
            log.warn(`Failed to resolve specifier: ${s} from ${filePath}`);
          } else {
            // Packages failure is debug only unless it's a critical entry point
            log.debug(`Module not found: ${s} from ${filePath}`);
          }
        }
      }
    }
    return results;
  }

  private async resolve(specifier: string, importer: string): Promise<string | null> {
    if (specifier.startsWith('.')) {
      const abs = path.resolve(path.dirname(importer), specifier);
      const candidates = [
        abs,
        abs + '.ts',
        abs + '.tsx',
        abs + '.js',
        abs + '.jsx',
        abs + '.mjs',
        abs + '.vue',
        abs + '.svelte',
        abs + '/index.ts',
        abs + '/index.tsx',
        abs + '/index.js',
        abs + '/index.jsx',
        abs + '/index.mjs'
      ];
      for (const c of candidates) {
        if (existsSync(c)) return normalizePath(c);
      }
    }
    // Package-internal subpath imports (`#client/constants`), declared in the
    // owning package.json's `imports` field. Svelte and other modern packages
    // use them internally; unresolved, they reached the bundle verbatim and
    // threw "Module not found: #client/constants" at runtime.
    if (specifier.startsWith('#')) {
      const internal = resolveSubpathImport(specifier, path.dirname(importer));
      if (internal) return normalizePath(internal);
      return null;
    }

    // Deep Scan node_modules for framework packages
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
      try {
        const resolved = _require.resolve(specifier, { paths: [path.dirname(importer), process.cwd()] });
        if (resolved) return normalizePath(resolved);
      } catch (e) {
        // require.resolve honours the `require` condition only, so any
        // ESM-only package (lit, svelte, solid-js and most modern libraries)
        // throws here. Fall through to the exports-map resolver below.
      }
      const esm = resolveEsmPackage(specifier, path.dirname(importer));
      if (esm) return normalizePath(esm);
    }
    return null;
  }

  async invalidate(filePath: string, rootDir: string) {
    const normalized = normalizePath(filePath);
    const type = this.detectType(normalized);
    const id = generateModuleId(type, normalized, rootDir);
    this.nodes.delete(id);
    await this.addEntry(filePath, rootDir);
  }

  validate(): GraphValidation {
    return { isValid: true, cycles: [], errors: [] };
  }

  getReachableNodes(entryPoints: string[]): string[] {
    const visited = new Set<string>();
    const queue = [...entryPoints];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);
      const node = this.nodes.get(curr);
      if (node) {
        for (const edge of node.edges) queue.push(edge.to);
      }
    }
    return Array.from(visited);
  }
}


/**
 * Resolves a bare specifier against a package's `exports` map using the
 * `import` condition, with `module`/`main` as fallbacks.
 *
 * Node's `require.resolve` only ever applies the `require` condition, so it
 * cannot see into ESM-only packages. Without this, their internal re-exports
 * (lit -> @lit/reactive-element, lit-html, ...) were silently dropped from the
 * graph and the produced bundle threw "Module not found" at runtime.
 */
function resolveEsmPackage(specifier: string, fromDir: string): string | null {
    const scoped = specifier.startsWith('@');
    const parts = specifier.split('/');
    const pkgName = scoped ? parts.slice(0, 2).join('/') : parts[0]!;
    const subpath = specifier.slice(pkgName.length) || '.';

    // Walk up looking for node_modules/<pkgName>.
    let dir = fromDir;
    let pkgDir: string | null = null;
    while (true) {
        const candidate = path.join(dir, 'node_modules', pkgName);
        if (existsSync(path.join(candidate, 'package.json'))) {
            pkgDir = candidate;
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    if (!pkgDir) return null;

    let manifest: any;
    try {
        manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
    } catch {
        return null;
    }

    const key = subpath === '.' ? '.' : `.${subpath.startsWith('/') ? subpath : `/${subpath}`}`;
    const target = selectExport(manifest.exports, key)
        ?? (key === '.' ? manifest.module ?? manifest.main : null)
        ?? (key === '.' ? null : key.slice(2));

    const tryFile = (rel: string | null): string | null => {
        if (!rel) return null;
        const abs = path.resolve(pkgDir!, rel);
        const candidates = [abs, `${abs}.js`, `${abs}.mjs`, path.join(abs, 'index.js'), path.join(abs, 'index.mjs')];
        for (const candidate of candidates) {
            if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        }
        return null;
    };

    return tryFile(typeof target === 'string' ? target : null) ?? tryFile(key === '.' ? 'index.js' : null);
}

/** Picks a file from an `exports` map, preferring browser/import conditions. */
function selectExport(exportsField: unknown, key: string): string | null {
    if (!exportsField) return null;
    if (typeof exportsField === 'string') return key === '.' ? exportsField : null;
    if (typeof exportsField !== 'object') return null;

    const map = exportsField as Record<string, unknown>;
    // A conditions-only map (no "." keys) applies to the root export.
    const isSubpathMap = Object.keys(map).some((k) => k === '.' || k.startsWith('./'));
    const entry = isSubpathMap ? map[key] : key === '.' ? map : undefined;
    if (entry === undefined) return null;

    return pickCondition(entry);
}

function pickCondition(entry: unknown): string | null {
    if (typeof entry === 'string') return entry;
    if (Array.isArray(entry)) {
        for (const item of entry) {
            const picked = pickCondition(item);
            if (picked) return picked;
        }
        return null;
    }
    if (!entry || typeof entry !== 'object') return null;

    const conditions = entry as Record<string, unknown>;
    // Bundler order: browser code wants the ESM build.
    for (const condition of ['browser', 'import', 'module', 'development', 'default', 'require', 'node']) {
        if (condition in conditions) {
            const picked = pickCondition(conditions[condition]);
            if (picked) return picked;
        }
    }
    return null;
}


/** Finds the package.json that owns `fromDir`, walking up to the filesystem root. */
function findOwningPackage(fromDir: string): { dir: string; manifest: any } | null {
    let dir = fromDir;
    while (true) {
        const candidate = path.join(dir, 'package.json');
        if (existsSync(candidate)) {
            try {
                return { dir, manifest: JSON.parse(readFileSync(candidate, 'utf-8')) };
            } catch {
                return null;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

/** Resolves a `#subpath` import against the owning package's `imports` map. */
function resolveSubpathImport(specifier: string, fromDir: string): string | null {
    const owner = findOwningPackage(fromDir);
    if (!owner?.manifest?.imports) return null;

    const imports = owner.manifest.imports as Record<string, unknown>;
    let target = pickCondition(imports[specifier]);

    if (!target) {
        // Wildcard patterns: "#client/*": "./src/internal/client/*.js"
        for (const [pattern, value] of Object.entries(imports)) {
            const star = pattern.indexOf('*');
            if (star === -1) continue;
            const prefix = pattern.slice(0, star);
            const suffix = pattern.slice(star + 1);
            if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
            const matched = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
            const picked = pickCondition(value);
            if (picked) {
                target = picked.replace('*', matched);
                break;
            }
        }
    }
    if (!target) return null;

    const abs = path.resolve(owner.dir, target);
    for (const candidate of [abs, `${abs}.js`, `${abs}.mjs`, path.join(abs, 'index.js')]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
}
