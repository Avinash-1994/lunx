// packages/lunx-adapter-core/src/registry.ts
import type { LunxAdapter, PackageJson } from './index.js';

export class AdapterRegistry {
  private adapters: LunxAdapter[] = [];

  register(adapter: LunxAdapter) {
    this.adapters.push(adapter);
  }

  // Priority order exactly as specified by Phase 0
  static readonly DETECTION_PRIORITY = [
    { pkg: '@sveltejs/kit', adapter: 'svelte-kit' },
    { pkg: 'nuxt', adapter: 'nuxt' },
    { pkg: '@solidjs/start', adapter: 'solid-start' },
    { pkg: '@builder.io/qwik-city', adapter: 'qwik-city' },
    { pkg: '@analogjs/platform', adapter: 'analog' },
    { pkg: '@angular/core', adapter: 'angular' },
    { pkg: '@remix-run/dev', adapter: 'remix' },
    { pkg: '@tanstack/start', adapter: 'tanstack-start' },
    { pkg: 'react-router', adapter: 'react-router' }, // >= 7
    { pkg: 'waku', adapter: 'waku' },
    { pkg: 'vitepress', adapter: 'vitepress' },
    { pkg: 'astro', adapter: 'astro' },
    { pkg: 'gatsby', adapter: 'gatsby' },
    { pkg: '@redwoodjs/core', adapter: 'redwood' },
    // SPA fallbacks — always after meta-frameworks
    { pkg: '@builder.io/qwik', adapter: 'qwik' },
    { pkg: 'solid-js', adapter: 'solid' },
    { pkg: 'svelte', adapter: 'svelte' },
    { pkg: 'vue', adapter: 'vue' },
    { pkg: 'preact', adapter: 'preact' },
    { pkg: 'lit', adapter: 'lit' },
    { pkg: 'react', adapter: 'react' },
    { pkg: 'alpinejs', adapter: 'alpine' },
  ];

  private activeAdapter: LunxAdapter | null = null;

  getActiveAdapter(): LunxAdapter | null {
    return this.activeAdapter;
  }

  detect(projectRoot: string, pkg: PackageJson): LunxAdapter | null {
    // 1. First, process registered adapters based on STRICT priority ordering
    const sortedAdapters = [...this.adapters].sort((a, b) => {
      const idxA = AdapterRegistry.DETECTION_PRIORITY.findIndex(p => p.adapter === a.name);
      const idxB = AdapterRegistry.DETECTION_PRIORITY.findIndex(p => p.adapter === b.name);
      return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
    });

    for (const adapter of sortedAdapters) {
      if (adapter.detect(projectRoot, pkg)) {
        if (adapter.name === 'gatsby') {
          console.warn('[LUNX:INFO] Gatsby adapter is currently in community preview. Report issues at https://lunx.dev/issues');
        }
        this.activeAdapter = adapter;
        return adapter;
      }
    }
    return null;
  }
}

export const registry = new AdapterRegistry();

// Fallback utility to dynamically detect UI meta-framework dependencies
export function detectDependencies(pkg: PackageJson, deps: string[]): boolean {
  const check = { ...pkg.dependencies, ...pkg.devDependencies };
  return deps.some(dep => Object.keys(check).includes(dep));
}
