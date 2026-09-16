/**
 * First-class SPA adapters so registry.detect() is not null on React/Vue/Svelte/Solid.
 * Meta-frameworks (Next, Nuxt, SvelteKit, …) take priority and are excluded here.
 */
import { registry, detectDependencies, type LunxAdapter, type LunxConfig, type PackageJson } from '@lunx/adapter-core';

const META_DEPS = [
  'next',
  'nuxt',
  '@sveltejs/kit',
  '@solidjs/start',
  '@builder.io/qwik-city',
  '@analogjs/platform',
  '@remix-run/dev',
  '@remix-run/react',
  '@tanstack/start',
  'waku',
  'astro',
  'vitepress',
  'gatsby',
  '@redwoodjs/core',
  '@angular/core',
];

function spaAdapter(name: string, deps: string[]): LunxAdapter {
  return {
    name,
    detect(_projectRoot: string, pkg: PackageJson): boolean {
      if (detectDependencies(pkg, META_DEPS)) return false;
      return detectDependencies(pkg, deps);
    },
    plugins() {
      return [];
    },
    config(config: LunxConfig): LunxConfig {
      return { ...config, framework: config.framework ?? name };
    },
  };
}

registry.register(spaAdapter('qwik', ['@builder.io/qwik']));
registry.register(spaAdapter('solid', ['solid-js']));
registry.register(spaAdapter('svelte', ['svelte']));
registry.register(spaAdapter('vue', ['vue']));
registry.register(spaAdapter('preact', ['preact']));
registry.register(spaAdapter('lit', ['lit']));
registry.register(spaAdapter('react', ['react']));
registry.register(spaAdapter('alpine', ['alpinejs']));
