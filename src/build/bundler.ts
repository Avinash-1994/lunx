import fs from 'fs';
import path from 'path';
import { BuildConfig } from '../config/index.js';


export async function build(rawConfig: BuildConfig) {
  let config = rawConfig;

  // Step 2: detect active framework adapter
  let adapter: any = null;
  try {
    const { registry } = await import('@lunx/adapter-core');
    const pkgPath = path.join(config.root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      // Pre-load common meta-framework adapters so they register themselves
      const adaptersToTry = [
        'solidstart', 'sveltekit', 'astro', 'qwikcity', 'remix', 
        'nextjs', 'nuxt', 'tanstack-start', 'waku', 'analog', 'react-router', 'vitepress', 'tauri', 'electron',
        'gatsby', 'redwoodjs', 'stencil', 'marko', 'docusaurus'
      ];
      
      for (const name of adaptersToTry) {
        try {
          await import(`../meta-frameworks/${name}/index.js`);
        } catch (e: any) {
          if (name === 'solidstart') console.log(`[DEBUG] Failed to import ${name}:`, e.message);
        }
      }
      try {
        await import('../framework-adapters/angular/index.js');
      } catch (e) {}
      try {
        await import('../framework-adapters/spa/index.js');
      } catch (e) {}

      adapter = registry.detect(config.root, pkg);
      if (!adapter) console.log(`[DEBUG] registry.detect returned null for ${config.root}`);
    }
  } catch (err) {
    console.error('[DEBUG] Failed to load adapter-core:', err);
    // Ignore if adapter-core is not available
  }



  // Step 3: let adapter modify config
  if (adapter) {
    if (adapter.config) {
      config = await adapter.config(config) as BuildConfig;
    }
    const metaProxies = new Set([
      'nextjs-pages', 'next', 'nuxt', 'svelte-kit', 'solidstart', 'remix',
      'tanstack-start', 'waku', 'analog', 'react-router', 'astro', 'vitepress',
      'gatsby', 'redwoodjs', 'qwik-city',
    ]);
    const extra = metaProxies.has(adapter.name)
      ? ` (upstream ${adapter.name}, not a Lunx SSR engine)`
      : '';
    console.log(`[lunx] adapter: ${adapter.name}${extra}`);
  }

  // Step 4: merge adapter plugins into plugin list
  if (adapter && adapter.plugins) {
    const adapterPlugins = adapter.plugins();
    config.plugins = [...adapterPlugins, ...(config.plugins ?? [])];
  }

  // 3.2: Plugin Permission Sandbox
  if (config.plugins) {
    try {
      const { createPluginPermissionProxy } = await import('@lunx/security');
      config.plugins = config.plugins.map((p: any) => {
        const perms = { declared: p.permissions || [], name: p.name || 'anonymous' };
        return createPluginPermissionProxy(p, perms, { 
          mode: config.mode === 'production' ? 'production' : 'development' 
        });
      });
    } catch (e) {
      console.warn('[lunx:security] Failed to load plugin permission sandbox:', e);
    }
  }

  console.log('🏗️  Starting Build Pipeline...');
  console.log('📁 Root:', config.root);
  console.log('📦 Entry:', config.entry);
  console.log('📂 Output:', config.outDir);

  // Phase 3.1 — Supply Chain Security Checks
  if (config.mode === 'production') {
    // Allow opting out via env var (CI/regression) or per-project config key
    const skipSecurity =
      process.env.LUNX_SKIP_SECURITY === '1' ||
      (config as any).security?.vulnSeverity === 'off';

    if (skipSecurity) {
      console.log('[lunx:security] Security gate skipped (vulnSeverity: off).');
    } else {
    try {
      const security = await import('@lunx/security');
      
      // 1. Lockfile audit
      const lockfileResult = await security.auditLockfile(config.root);
      if (!lockfileResult.clean) {
        throw new Error('Lockfile tampering detected! Aborting build.');
      }
      
      // 2. CVE Scan
      const pkgPath = path.join(config.root, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const packagesToScan = Object.entries(deps).map(([name, version]) => ({
          name, 
          version: String(version).replace(/^[^0-9]/, '')
        }));
        
        const cacheDir = path.join(config.root, '.lunx', 'security');
        const cveResult = await security.scanCVE(packagesToScan, { cacheDir, distDir: config.outDir });
        if (!cveResult.clean) {
          throw new Error('HIGH CVE detected in dependencies! Aborting build.');
        }
      }
    } catch (err: any) {
      if (err.message.includes('Lockfile tampering') || err.message.includes('HIGH CVE')) {
        throw err;
      }
      console.warn('[lunx] Security modules not fully available or failed:', err.message);
    }
    }
  }

  const { FrameworkPipeline } = await import('../core/pipeline/framework-pipeline.js');
  const pipeline = await FrameworkPipeline.auto(config);

  try {
    const result = await pipeline.build();
    if (!result.success) {
      const errorMsg = (result as any).error?.message || 'Unknown build error';
      throw new Error(errorMsg);
    }

    // Phase 3.1 & 3.2 — Output Analysis & Generation
    if (config.mode === 'production') {
      const security = await import('@lunx/security');
      const buildOutDir = config.outDir || 'build_output';
      
      // 3.2 Secret Scanning
      const filesToScan: Record<string, string> = {};
      const scanDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) scanDir(p);
          else {
            const ext = path.extname(p).toLowerCase();
            if (['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.ts'].includes(ext)) {
              filesToScan[p] = fs.readFileSync(p, 'utf8');
            }
          }
        }
      };
      scanDir(buildOutDir);
      
      const scanResult = security.scanSecrets(filesToScan);
      if (!scanResult.clean) {
        throw new Error('Potential secret detected in bundle output! Aborting build.');
      }

      try {
        const pkgPath = path.join(config.root, 'package.json');
        
        // S1.1 - Extract actual used dependencies from the build graph
        const graph = pipeline.getEngine().getGraph();
        let deps: string[] = [];
        
        if (graph) {
          const depSet = new Set<string>();
          for (const node of graph.nodes.values()) {
            if (node.path.includes('node_modules')) {
              const parts = node.path.split(/node_modules[\\\/]/);
              if (parts.length > 1) {
                const rest = parts[1].split(/[\\\/]/);
                if (rest[0].startsWith('@') && rest.length > 1) {
                  depSet.add(`${rest[0]}/${rest[1]}`);
                } else if (rest[0]) {
                  depSet.add(rest[0]);
                }
              }
            }
          }
          deps = Array.from(depSet);
        }

        if (deps.length === 0 && fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
        }
        
        const sbom = await security.generateSBOM(config.root, deps);
        const outPath = path.join(buildOutDir, 'lunx-sbom.json');
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(sbom, null, 2), 'utf8');
      } catch (e: any) {
        console.warn('[lunx:security] Failed to generate SBOM:', e.message);
      }

      // 3.3 Output Hardening (SRI, CSP, Headers)
      try {
        const sriManifest = security.generateSRI(buildOutDir);
        const cspResult = security.generateCSP(buildOutDir);
        const secHeaders = security.generateSecurityHeaders(buildOutDir, cspResult.header);
        
        fs.writeFileSync(path.join(buildOutDir, '_headers'), secHeaders.configs.netlify, 'utf8');
        fs.writeFileSync(path.join(buildOutDir, '.htaccess'), secHeaders.configs.apache, 'utf8');

        // Inject SRI and CSP into HTML
        const injectHtml = (dir: string) => {
          if (!fs.existsSync(dir)) return;
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) injectHtml(p);
            else if (path.extname(p).toLowerCase() === '.html') {
              let html = fs.readFileSync(p, 'utf8');
              html = security.injectSRIIntoHTML(html, sriManifest);
              if (!html.includes('Content-Security-Policy')) {
                html = html.replace(/<head[^>]*>/i, `$&\\n    ${cspResult.metaTag}`);
              }
              fs.writeFileSync(p, html, 'utf8');
            }
          }
        };
        injectHtml(buildOutDir);
      } catch (e: any) {
        console.warn('[lunx:security] Failed to apply output hardening:', e.message);
      }
    }

    // Day 52: Print final bundle stats in production mode
    if (config.mode === 'production') {
      const { printBundleStats } = await import('./bundle-stats.js');
      // Extract artifacts from targets
      const artifacts = (result as any).targets ? (result as any).targets.flatMap((t: any) => t.artifacts) : (result as any).artifacts || [];
      printBundleStats(artifacts);
    }

    // Step 6: run adapter post-build hook
    const outDir = config.outDir || 'build_output';
    if (adapter && adapter.buildOutput) {
      await adapter.buildOutput(outDir);
    }

    console.log('✅ Build completed successfully!');
    return result; // Added
  } catch (error: any) {
    console.error('❌ Build failed:', error.message);
    throw error;
  } finally {
    await pipeline.close();
  }
}
