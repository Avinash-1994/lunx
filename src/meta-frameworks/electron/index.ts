import type { LunxAdapter, Plugin, LunxConfig, PackageJson, Middleware } from '@lunx/adapter-core';
import { detectDependencies, registry } from '@lunx/adapter-core';

/**
 * Electron: the renderer is a regular lunx app; the main process and preload
 * are built, and Electron started on the dev server, by vite-plugin-electron
 * (`lunx create --template electron`), which runs on lunx's plugin bridge.
 */
export class ElectronAdapter implements LunxAdapter {
  name = 'electron';

  detect(_projectRoot: string, pkg: PackageJson): boolean {
    return detectDependencies(pkg, ['electron', 'electron-builder']);
  }

  plugins(): Plugin[] {
    return [];
  }

  config(config: LunxConfig): LunxConfig {
    return config;
  }

  getDevHandler(): Middleware {
    return async (_req: any, _res: any, next: any) => next();
  }

  serverMiddleware(): Middleware[] {
    return [];
  }
}

registry.register(new ElectronAdapter());
