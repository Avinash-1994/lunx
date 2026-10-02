/**
 * Lunx Module Federation
 *
 * Implements the Module Federation protocol compatible with webpack 5 MF.
 * Works in both dev (dynamic import from remote URL) and build (remoteEntry.js).
 *
 * Architecture:
 *  Remote app  → generates remoteEntry.js that exposes modules
 *  Host app    → runtime loader fetches remoteEntry.js and calls get()
 */

import type { LegacyPlugin as Plugin } from '../types/legacy-plugin.js'
import fs from 'fs'
import path from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FederationConfig {
  name: string
  remotes?: Record<string, string>
  exposes?: Record<string, string>
  shared?: Record<string, SharedConfig | boolean>
  filename?: string
}

export interface SharedConfig {
  singleton?: boolean
  requiredVersion?: string
  eager?: boolean
}

export interface FederationBuildResult {
  remoteEntryCode: string
  containerInitCode: string
}

// ─── Shared scope runtime ─────────────────────────────────────────────────────

/** Injected once into the host page — manages shared singleton deps */
export const SHARED_SCOPE_RUNTIME = `
(function() {
  if (typeof __lunx_shared__ !== 'undefined') return;
  
  var _shared = {};
  var _initialized = {};

  globalThis.__lunx_shared__ = {
    /** Register a version of a shared module */
    register: function(name, version, factory, eager) {
      if (!_shared[name]) _shared[name] = {};
      _shared[name][version] = { factory: factory, loaded: false, instance: null, eager: !!eager };
      if (eager) {
        this.get(name, version);
      }
    },
    /** Get the best matching version of a shared module */
    get: function(name, requestedVersion) {
      var versions = _shared[name];
      if (!versions) return null;
      
      // Exact match first
      if (versions[requestedVersion]) {
        var entry = versions[requestedVersion];
        if (!entry.loaded) {
          entry.instance = entry.factory();
          entry.loaded = true;
        }
        return entry.instance;
      }
      
      // Return first available (singleton behaviour)
      var keys = Object.keys(versions);
      if (keys.length > 0) {
        var e = versions[keys[0]];
        if (!e.loaded) {
          e.instance = e.factory();
          e.loaded = true;
        }
        return e.instance;
      }
      return null;
    },
    /** Check if a shared module is available */
    has: function(name) {
      return !!_shared[name] && Object.keys(_shared[name]).length > 0;
    }
  };
})();
`

// ─── Remote entry template ────────────────────────────────────────────────────

/**
 * Generates the remoteEntry.js content for a remote app.
 * This file is fetched by the host at runtime.
 */
export function generateRemoteEntry(
  config: FederationConfig,
  exposedModules: Record<string, string>   // key → bundled code
): string {
  const exposesEntries = Object.entries(exposedModules)
    .map(([key, code]) => {
      const safeKey = JSON.stringify(key)
      // Wrap the module code in a factory function
      return `  ${safeKey}: function() {
    var module = { exports: {} };
    (function(module, exports) {
${code.split('\n').map(l => '      ' + l).join('\n')}
    })(module, module.exports);
    return module.exports;
  }`
    })
    .join(',\n')

  const sharedEntries = config.shared
    ? Object.entries(config.shared)
        .map(([pkg, cfg]) => {
          const sharedCfg = typeof cfg === 'boolean' ? {} : cfg
          const version = sharedCfg.requiredVersion ?? '*'
          const singleton = sharedCfg.singleton ?? true
          const eager = sharedCfg.eager ?? false
          return `  ${JSON.stringify(pkg)}: { version: ${JSON.stringify(version)}, singleton: ${singleton}, eager: ${eager} }`
        })
        .join(',\n')
    : ''

  return `// Lunx Module Federation — Remote Entry
// App: ${config.name}
// Generated: ${new Date().toISOString()}
(function() {
  var __modules__ = {
${exposesEntries}
  };

  var __shared__ = {
${sharedEntries}
  };

  // Register shared deps into the global scope
  if (typeof globalThis.__lunx_shared__ !== 'undefined' && Object.keys(__shared__).length > 0) {
    Object.keys(__shared__).forEach(function(pkg) {
      var cfg = __shared__[pkg];
      // Only register if we have the module available
      try {
        var factory = function() { return require(pkg); };
        globalThis.__lunx_shared__.register(pkg, cfg.version, factory, cfg.eager);
      } catch(e) {
        // Module not available as shared - that's okay
      }
    });
  }

  // Container API — compatible with webpack 5 MF protocol
  var container = {
    name: ${JSON.stringify(config.name)},
    
    /** Initialize shared scope */
    init: function(sharedScope) {
      // Merge external shared scope with ours
      if (sharedScope && typeof globalThis.__lunx_shared__ !== 'undefined') {
        Object.keys(sharedScope).forEach(function(name) {
          if (!globalThis.__lunx_shared__.has(name)) {
            Object.keys(sharedScope[name]).forEach(function(version) {
              globalThis.__lunx_shared__.register(name, version, sharedScope[name][version].get, false);
            });
          }
        });
      }
    },

    /** Get an exposed module by its key */
    get: function(moduleName) {
      var factory = __modules__[moduleName] || __modules__['./' + moduleName];
      if (!factory) {
        return Promise.reject(new Error(
          '[Lunx MF] Module "' + moduleName + '" not found in remote "' + ${JSON.stringify(config.name)} + '". ' +
          'Available: ' + Object.keys(__modules__).join(', ')
        ));
      }
      return Promise.resolve(factory);
    }
  };

  // Register on globalThis so the host can access it
  var globalKey = 'lunx_remote_' + ${JSON.stringify(config.name)};
  globalThis[globalKey] = container;
  
  // Also register under the app name directly (for compatibility)
  globalThis[${JSON.stringify(config.name)}] = container;

  // Signal that this remote is ready
  var event = new CustomEvent('lunx:remote:ready', { detail: { name: ${JSON.stringify(config.name)} } });
  if (typeof document !== 'undefined') {
    document.dispatchEvent(event);
  }
})();
`
}

// ─── Runtime loader (injected into host) ─────────────────────────────────────

/**
 * This code runs in the host app browser.
 * It fetches remoteEntry.js files and resolves modules from them.
 */
function normalizeRemoteUrl(url: string): string {
  const webpackRemote = /^([A-Za-z0-9_$-]+)@(https?:\/\/.*)$/;
  const match = webpackRemote.exec(url);
  if (match) {
    return match[2];
  }
  return url;
}

export function generateFederationRuntime(
  remotes: Record<string, string>
): string {
  const normalizedRemotes = Object.entries(remotes).reduce<Record<string, string>>((acc, [name, value]) => {
    acc[name] = normalizeRemoteUrl(value);
    return acc;
  }, {});

  const remotesJson = JSON.stringify(normalizedRemotes, null, 2)

  return `
// Lunx Module Federation Runtime
// Injected into host app
(function() {
  if (typeof globalThis.__lunx_federation__ !== 'undefined') return;

  ${SHARED_SCOPE_RUNTIME}

  var __remotes__ = ${remotesJson};
  var __loaded__ = {};
  var __loading__ = {};

  /**
   * Load a remote app's container.
   * Returns a promise that resolves to the container object.
   */
  function loadRemote(remoteName) {
    // Already loaded
    if (__loaded__[remoteName]) {
      return Promise.resolve(__loaded__[remoteName]);
    }

    // In flight
    if (__loading__[remoteName]) {
      return __loading__[remoteName];
    }

    var url = __remotes__[remoteName];
    if (!url) {
      return Promise.reject(
        new Error('[Lunx MF] Unknown remote: "' + remoteName + '". Configured remotes: ' + Object.keys(__remotes__).join(', '))
      );
    }

    var promise = new Promise(function(resolve, reject) {
      var script = document.createElement('script');
      script.type = 'module';
      script.crossOrigin = 'anonymous';
      script.src = url;
      script.async = true;

      script.onload = function() {
        // The script registers itself on globalThis
        var container = globalThis['lunx_remote_' + remoteName] || globalThis[remoteName];
        if (!container) {
          reject(new Error('[Lunx MF] Remote "' + remoteName + '" loaded but container not found on globalThis. ' +
            'Make sure the remote app was built with Lunx MF.'));
          return;
        }

        // Initialize with shared scope
        if (typeof container.init === 'function') {
          container.init(globalThis.__lunx_shared__ || {});
        }

        __loaded__[remoteName] = container;
        delete __loading__[remoteName];
        resolve(container);
      };

      script.onerror = function(err) {
        delete __loading__[remoteName];
        reject(new Error('[Lunx MF] Failed to load remote "' + remoteName + '" from ' + url));
      };

      document.head.appendChild(script);
    });

    __loading__[remoteName] = promise;
    return promise;
  }

  /**
   * Import a module from a remote app.
   * Usage: __lunx_import__('cart/CartWidget')
   */
  globalThis.__lunx_import__ = function(moduleId) {
    var parts = moduleId.split('/');
    var remoteName = parts[0];
    var modulePath = './' + parts.slice(1).join('/');

    return loadRemote(remoteName).then(function(container) {
      return container.get(modulePath);
    }).then(function(factory) {
      return typeof factory === 'function' ? factory() : factory;
    });
  };

  /**
   * Preload a remote — fetches the container without importing any module yet.
   * Call this early to warm up the remote.
   */
  globalThis.__lunx_preload__ = function(remoteName) {
    return loadRemote(remoteName);
  };

  globalThis.__lunx_federation__ = {
    remotes: __remotes__,
    loaded: __loaded__,
    loadRemote: loadRemote,
  };
})();
`
}

// ─── esbuild plugin ───────────────────────────────────────────────────────────

/**
 * esbuild plugin that handles `import X from 'remoteName/ModuleName'`
 * by rewriting it to use the federation runtime loader at build time.
 */
export function federationPlugin(config: FederationConfig): Plugin {
  const remoteNames = new Set(Object.keys(config.remotes ?? {}))

  return {
    name: 'lunx-module-federation',

    setup(build) {
      // ── Intercept imports from remote names ─────────────────────────────────
      // e.g. import CartWidget from 'cart/CartWidget'
      //        remoteName ^     ^ modulePath
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        const [remoteName, ...rest] = args.path.split('/')

        if (remoteNames.has(remoteName) && rest.length > 0) {
          return {
            path: args.path,
            namespace: 'lunx-federation-remote',
          }
        }
        return null
      })

      // ── Generate proxy module for each remote import ─────────────────────────
      build.onLoad(
        { filter: /.*/, namespace: 'lunx-federation-remote' },
        (args) => {
          const [remoteName, ...rest] = args.path.split('/')
          const modulePath = rest.join('/')
          const moduleId = `${remoteName}/${modulePath}`

          // Generate a proxy that uses the runtime loader
          const contents = `
// Lunx MF: proxy for '${moduleId}'
// This module is loaded from remote '${remoteName}' at runtime

var __module__ = null;
var __promise__ = null;

function __loadModule__() {
  if (__module__) return Promise.resolve(__module__);
  if (__promise__) return __promise__;

  if (typeof globalThis.__lunx_import__ === 'undefined') {
    throw new Error(
      '[Lunx MF] Federation runtime not found. ' +
      'Make sure the host app has federation configured in lunx.config.js'
    );
  }

  __promise__ = globalThis.__lunx_import__(${JSON.stringify(moduleId)}).then(function(m) {
    __module__ = m;
    __promise__ = null;
    return m;
  });

  return __promise__;
}

// Default export — lazy proxy
var proxy = new Proxy({}, {
  get: function(target, prop) {
    if (__module__) {
      return __module__[prop];
    }
    // Return a lazy function for component usage
    if (prop === 'default' || prop === '__esModule') {
      return __module__ ? __module__[prop] : undefined;
    }
    return function() {
      throw new Error(
        '[Lunx MF] Module "${moduleId}" not yet loaded. ' +
        'Use React.lazy(() => import("${moduleId}")) or await lunx.preload("${remoteName}").'
      );
    };
  }
});

export { __loadModule__ as __load };
export default proxy;
`

          return { contents, loader: 'js' }
        }
      )

      // ── Inject runtime into entry point ─────────────────────────────────────
      if (config.remotes && Object.keys(config.remotes).length > 0) {
        build.onLoad({ filter: /\.(tsx?|jsx?)$/ }, async (args) => {
          // Only inject into the entry file
          const entryPoints = (build.initialOptions.entryPoints as string[]) ?? []
          const isEntry = entryPoints.some((ep) =>
            path.resolve(ep) === path.resolve(args.path)
          )

          if (!isEntry) return null

          const source = await fs.promises.readFile(args.path, 'utf-8')
          const runtime = generateFederationRuntime(config.remotes!)
          const ext = path.extname(args.path).slice(1) as
            | 'ts'
            | 'tsx'
            | 'js'
            | 'jsx'

          return {
            contents: `
// Lunx MF: Runtime injected by federation plugin
(function() {
  if (typeof window === 'undefined') return; // Skip in SSR
  var script = document.createElement('script');
  script.textContent = ${JSON.stringify(runtime)};
  document.head.appendChild(script);
})();

${source}`,
            loader: ext,
          }
        })
      }
    },
  }
}

// ─── HTML injection for remoteEntry ──────────────────────────────────────────

/**
 * Inject remoteEntry scripts into index.html for the host app.
 * Call this when processing the HTML output.
 */
export function injectRemotesIntoHTML(
  html: string,
  remotes: Record<string, string>
): string {
  const scriptTags = Object.entries(remotes)
    .map(
      ([name, url]) => {
        const normalized = normalizeRemoteUrl(url);
        return `  <script type="module" src="${normalized}" crossorigin="anonymous" data-lunx-remote="${name}"></script>`;
      }
    )
    .join('\n')

  // Inject before </head>
  return html.replace('</head>', `${scriptTags}\n</head>`)
}

// ─── Config validator ─────────────────────────────────────────────────────────

export function validateFederationConfig(config: FederationConfig): string[] {
  const errors: string[] = []

  if (!config.name) {
    errors.push('federation.name is required')
  }

  if (config.name && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(config.name)) {
    errors.push(
      `federation.name "${config.name}" must be a valid JS identifier (no hyphens)`
    )
  }

  if (config.remotes) {
    for (const [key, url] of Object.entries(config.remotes)) {
      const normalizedUrl = normalizeRemoteUrl(url);
      if (!normalizedUrl.endsWith('.js')) {
        errors.push(
          `federation.remotes["${key}"] = "${url}" should point to a .js file (typically remoteEntry.js)`
        );
      }
      try {
        new URL(normalizedUrl);
      } catch {
        if (!normalizedUrl.startsWith('/')) {
          errors.push(
            `federation.remotes["${key}"] = "${url}" is not a valid URL or absolute path`
          );
        }
      }
    }
  }

  if (config.exposes) {
    for (const [key, filePath] of Object.entries(config.exposes)) {
      if (!key.startsWith('./')) {
        errors.push(
          `federation.exposes key "${key}" should start with "./" (e.g. "./MyComponent")`
        )
      }
    }
  }

  return errors
}
