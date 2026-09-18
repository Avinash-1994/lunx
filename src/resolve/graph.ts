import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
import { canonicalHash } from '../core/engine/hash.js';
import { normalizePath, generateModuleId } from './utils.js';
import fs from 'fs/promises';
import { existsSync } from 'fs';
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

    // Capture standard import/export strings
    const matches = content.matchAll(/(?:import|export)\s+(?:.*?\s+from\s+)?['"](.*?)['"]/g);
    for (const m of matches) {
      const s = m[1];
      if (s && !specifiers.includes(s) && !s.includes(' ') && s.length < 500) {
        specifiers.push(s);
      }
    }

    const sideEffectMatches = content.matchAll(/import\s+['"](.*?)['"]/g);
    for (const m of sideEffectMatches) {
      const s = m[1];
      if (s && !specifiers.includes(s) && !s.includes(' ') && s.length < 500) {
        specifiers.push(s);
      }
    }

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
    // Deep Scan node_modules for framework packages
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/')) {
      try {
        const resolved = _require.resolve(specifier, { paths: [path.dirname(importer), process.cwd()] });
        if (resolved) return normalizePath(resolved);
      } catch (e) {
        // ignore
      }
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
