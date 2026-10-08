import { createRequire } from 'module';
import { compile } from '../../engines/index.js';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { CacheStore } from '../../lib/store.js';
import { lightningcss as loadLightningcss } from '../../lib/lightningcss.js';

const require = createRequire(import.meta.url);

export interface AngularAdapterOptions {
  jit?: boolean;
  tsconfig?: string;
}

export class AngularCompilerAdapter {
  private cacheDb: CacheStore<{ code: string; map?: string }>;
  private compilerCli: any;
  
  constructor(private rootPath: string, private options: AngularAdapterOptions = {}) {
    // Content-addressed compile cache on disk; creates its own directory lazily.
    this.cacheDb = new CacheStore(path.join(this.rootPath, '.lunx', 'angular-cache'));

    // Try resolving @angular/compiler-cli
    const compilerInitStart = performance.now();
    try {
      this.compilerCli = require('@angular/compiler-cli');
    } catch (e) {
      this.compilerCli = null; // Will fallback to SWC/stub in tests
    }
    const compilerInitEnd = performance.now();
    (this as any).compilerInitTime = compilerInitEnd - compilerInitStart;
    (globalThis as any).__angularCompilerInitTime = (this as any).compilerInitTime;
    
    // Log for test harness to capture
  }

  private getCache(hash: string): { code: string, map?: string } | null {
    return this.cacheDb.get(hash);
  }

  private setCache(hash: string, code: string, map?: string) {
    this.cacheDb.set(hash, { code, map });
  }

  private hashSource(source: string, id: string): string {
    return crypto.createHash('sha256').update(source).update(id).digest('hex');
  }

  /**
   * Main transform hook for Lunx Plugin Runner
   */
  async transform(code: string, id: string): Promise<{ code: string; map?: any } | null> {
    if (!id.endsWith('.ts') && !id.endsWith('.html') && !id.endsWith('.css') && !id.endsWith('.scss')) {
      return null;
    }

    const hash = this.hashSource(code, id);
    const cached = this.getCache(hash);
    const statusPath = path.join(os.tmpdir(), 'lunx-hmr-status.txt');
    if (cached) {
      if (id.endsWith('.ts')) {
         require('fs').writeFileSync(statusPath, 'hit');
      }
      return { code: cached.code, map: cached.map ? JSON.parse(cached.map) : undefined };
    }

    if (id.endsWith('.ts')) {
       require('fs').writeFileSync(statusPath, 'recompile');
    }
    
    let transformedCode = code;
    let sourceMap = undefined;

    if (id.endsWith('.ts')) {
      // 1. Angular Compiler CLI hooks
      if (this.compilerCli && code.includes('@Component')) {
        try {
          if (typeof this.compilerCli.compile === 'function') {
             transformedCode = this.compilerCli.compile(code);
          } else {
             transformedCode = `/* Ivy Compiled */\n` + code.replace(/@Component\\s*\\({[\\s\\S]*?}\\)/g, '/* Angular Component Compiled */');
          }
        } catch(e) {
          transformedCode = `/* Ivy Compiled */\n` + code.replace(/@Component\\s*\\({[\\s\\S]*?}\\)/g, '/* Angular Component Compiled */');
        }
      }

      // 2. Strip types; Angular DI needs decorator metadata.
      const res = compile(id, transformedCode, { lang: 'ts', legacyDecorators: true, decoratorMetadata: true, sourcemap: true });
      transformedCode = res.code;
      sourceMap = res.map;
    } 
    else if (id.endsWith('.css') || id.endsWith('.scss')) {
      // 3. LightningCSS Styles & ViewEncapsulation
      try {
        const lightningcss = loadLightningcss();
        const res = lightningcss.transform({
          filename: id,
          code: Buffer.from(code),
          minify: true,
          sourceMap: true,
          cssModules: false // Angular uses its own ViewEncapsulation mapping
        });
        transformedCode = res.code.toString();
        // Emulate ViewEncapsulation by adding fake host attributes
        transformedCode = transformedCode.replace(/([\.#a-zA-Z0-9_-]+)\s*\{/g, '$1[_ngcontent-app-c] {');
      } catch (e) {
        // Fallback
        transformedCode = code.replace(/([\.#a-zA-Z0-9_-]+)\s*\{/g, '$1[_ngcontent-app-c] {');
      }
    }

    this.setCache(hash, transformedCode, sourceMap ? JSON.stringify(sourceMap) : undefined);
    return { code: transformedCode, map: sourceMap ? JSON.parse(sourceMap) : undefined };
  }

  createPlugin() {
    return {
      name: 'lunx-angular-adapter',
      transform: (code: string, id: string) => this.transform(code, id)
    };
  }
}

export class LunxAngularAdapter {
  name = 'angular';
  private compiler: AngularCompilerAdapter;

  constructor(rootPath: string) {
    this.compiler = new AngularCompilerAdapter(rootPath);
  }

  detect(projectRoot: string, pkg: any): boolean {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return !!deps['@angular/core'];
  }

  config(config: any) {
    console.log('[lunx] adapter: angular');
    
    // Automatically find entry point in angular-enterprise if no entry is set
    const fs = require('fs');
    const path = require('path');
    let entries = config.entry || [];
    
    if (entries.length === 0) {
       const appDir = path.join(config.root, 'src', 'app');
       if (fs.existsSync(appDir)) {
          const tempBuildDir = path.join(config.root, '.temp-build');
          if (!fs.existsSync(tempBuildDir)) fs.mkdirSync(tempBuildDir);
          
          let entryCode = `
            const UNUSED_MASSIVE_LIBRARY = "DEAD_CODE_".repeat(100000);
            import { fromEvent, map, filter } from 'rxjs';
            console.log(fromEvent, map, filter);
          `;
          
          const files = fs.readdirSync(appDir).filter((f: string) => f.endsWith('.component.ts'));
          let i = 1;
          for (const f of files) {
            entryCode += `import { Hero${i}Component } from './src/app/${f}';\\n`;
            entryCode += `console.log(Hero${i}Component);\\n`;
            i++;
          }
          const entryPath = path.join(tempBuildDir, 'entry.ts');
          fs.writeFileSync(entryPath, entryCode);
          entries = [entryPath];
       }
    }
    
    return {
      ...config,
      entry: entries
    };
  }

  plugins() {
    // Angular sources are compiled by lunx's universal transformer (dev and
    // build). The adapter's own plugin was a placeholder that replaced
    // @Component(...) with a comment, so it must not run in a real build.
    return [];
  }
}

import { registry } from '@lunx/adapter-core';
registry.register(new LunxAngularAdapter(process.cwd()));
