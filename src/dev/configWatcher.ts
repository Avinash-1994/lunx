/**
 * ConfigWatcher — Phase 3.3
 * Watches lunx.config.ts, tsconfig.json, .env etc. for changes.
 * Uses native Rust watcher first; falls back to chokidar.
 */
import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';

export type ReloadType = 'hot' | 'rebuild' | 'restart';

// Try loading native watcher — fail silently so chokidar takes over
let NativeWatcher: any = null;
try {
    if (process.env.LUNX_WATCHER !== 'chokidar') {
        const native = await import('../native/index.js');
        NativeWatcher = native.NativeWatcher;
    }
} catch (e: any) {
    console.warn(`[lunx] Native watcher unavailable, falling back to chokidar: ${e?.message ?? e}`);
}

export class ConfigWatcher {
    private nativeWatcher: any = null;
    private chokidarWatcher: any = null;

    constructor(
        private root: string,
        private onReload: (type: ReloadType, file: string) => void
    ) { }

    async start() {
        const configFiles = [
            'lunx.config.ts', 'lunx.config.js', 'lunx.config.json',
            'tailwind.config.js', 'tsconfig.json', '.env', '.env.local'
        ].map(f => path.join(this.root, f));

        // notify cannot watch paths that do not exist yet (e.g. lunx.config.js
        // when the project only has lunx.config.ts). Watching missing files
        // previously aborted the entire native watcher and fell back to chokidar.
        const existingConfigFiles = configFiles.filter((f) => {
            try { return fs.existsSync(f); } catch { return false; }
        });
        const watchPaths = existingConfigFiles.length > 0 ? existingConfigFiles : [this.root];
        const configSet = new Set(configFiles);
        const configNames = new Set(configFiles.map((f) => path.basename(f)));

        if (NativeWatcher) {
            try {
                this.nativeWatcher = new NativeWatcher();
                this.nativeWatcher.start(watchPaths, (_err: any, event: any) => {
                    if (_err || event.kind === 'access') return;
                    for (const p of event.paths as string[]) {
                        const filename = path.basename(p);
                        if (!configSet.has(p) && !configNames.has(filename)) continue;
                        const type = this.determineReloadType(filename);
                        log.info(`Config changed: ${filename} -> ${type} [native]`, { category: 'server' });
                        this.onReload(type, p);
                    }
                });
                return;
            } catch (e: any) {
                log.warn(`[lunx] ConfigWatcher native failed (${e.message}), using chokidar.`);
            }
        }

        // Chokidar fallback
        try {
            const { default: chokidar } = await import('chokidar');
            this.chokidarWatcher = chokidar.watch(configFiles, { ignoreInitial: true });
            this.chokidarWatcher.on('change', (file: string) => {
                const filename = path.basename(file);
                const type = this.determineReloadType(filename);
                log.info(`Config changed: ${filename} -> ${type}`, { category: 'server' });
                this.onReload(type, file);
            });
        } catch (e: any) {
            log.error(`[lunx] ConfigWatcher: both native and chokidar failed: ${e.message}`);
        }
    }

    private determineReloadType(filename: string): ReloadType {
        if (filename.startsWith('.env')) return 'hot';
        if (filename === 'tsconfig.json') return 'rebuild';
        if (filename.includes('tailwind')) return 'rebuild';
        return 'restart';
    }

    async close() {
        this.nativeWatcher?.stop?.();
        await this.chokidarWatcher?.close?.();
    }
}
