import type { LunxAdapter, Plugin, LunxConfig, PackageJson, Middleware } from '@lunx/adapter-core';
import { detectDependencies, registry } from '@lunx/adapter-core';

/**
 * Electron: the renderer is a regular lunx app; lunx builds the main process
 * and preload and runs Electron on the dev server (src/electron). A project
 * that uses vite-plugin-electron keeps it, on lunx's plugin bridge.
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
