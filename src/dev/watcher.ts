/**
 * DevWatcher — Phase 3.3
 *
 * Tries the native Rust watcher (notify crate) first.
 * Falls back to chokidar if native module is unavailable — zero regression.
 * Per master plan: "Keep chokidar as a fallback. Print one WARN line."
 */

import { EventEmitter } from 'events';
import { explainReporter } from '../core/engine/events.js';

// ─── Try native watcher ───────────────────────────────────────────────────────
let NativeWatcher: any = null;
try {
    if (process.env.LUNX_WATCHER !== 'chokidar') {
        const native = await import('../native/index.js');
        NativeWatcher = native.NativeWatcher;
    }
} catch (e: any) {
    // We do NOT log here, we log when the watcher is actually started.
}

// ─── DevWatcher ───────────────────────────────────────────────────────────────

export class DevWatcher extends EventEmitter {
    private nativeWatcher: any = null;
    private chokidarWatcher: any = null;
    private batch: Set<string> = new Set();
    private timer: NodeJS.Timeout | null = null;
    private engine: 'rust-notify' | 'chokidar' | 'unknown' = 'unknown';

    constructor(private rootDir: string, private debounceMs: number = 50) {
        super();
        this.start();
    }

    private start() {
        const ignoredPatterns = [
            '**/node_modules/**', '**/.git/**', '**/dist/**', '**/.lunx/**', '**/.lunx_cache/**'
        ];

        if (NativeWatcher) {
            try {
                this.nativeWatcher = new NativeWatcher();
                this.nativeWatcher.start([this.rootDir], (_err: any, event: any) => {
                    if (_err) return;
                    // Filter out ignored paths
                    const paths: string[] = (event.paths || []).filter((p: string) =>
                        !ignoredPatterns.some(pat => {
                            const re = pat.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
                            return new RegExp(re).test(p);
                        })
                    );
                    if (paths.length > 0 && event.kind !== 'access') {
                        paths.forEach(p => this.addToBatch(p));
                    }
                });
                this.engine = 'rust-notify';
                // Resolve real version from package.json; never use a hardcoded placeholder
                let lunxNativeVer = '0.1.0';
                try {
                    const pkg = require('../../package.json');
                    lunxNativeVer = pkg.version ?? '0.1.0';
                } catch { /* package.json not readable — use safe default */ }
                const ver = typeof this.nativeWatcher.getVersion === 'function'
                    ? this.nativeWatcher.getVersion()
                    : `rust-notify (lunx-native v${lunxNativeVer})`;
                console.log(`[lunx] watcher: ${ver}`);
                return;
            } catch (err: any) {
                console.warn(`[lunx] WARN: native watcher failed to load, falling back to chokidar (`, err?.message ?? err, `)`);
            }
        } else {
            console.warn(`[lunx] WARN: native watcher failed to load, falling back to chokidar`);
        }

        // Chokidar fallback
        this.startChokidar(ignoredPatterns);
    }

    private async startChokidar(ignored: string[]) {
        try {
            const { default: chokidar } = await import('chokidar');
            this.chokidarWatcher = chokidar.watch(this.rootDir, {
                ignored,
                ignoreInitial: true
            });
            this.chokidarWatcher.on('all', (event: string, filePath: string) => {
                if (event === 'add' || event === 'change' || event === 'unlink') {
                    this.addToBatch(filePath);
                }
            });
            this.engine = 'chokidar';
        } catch (err: any) {
            console.error(`[lunx] Both native watcher and chokidar failed: ${err.message}`);
        }
    }

    getWatcherAdapter(): 'rust-notify' | 'chokidar' | 'unknown' {
        return this.engine;
    }

    private addToBatch(filePath: string) {
        this.batch.add(filePath);
        if (this.timer) clearTimeout(this.timer);

        this.timer = setTimeout(() => {
            const sortedBatch = Array.from(this.batch).sort();
            this.batch.clear();
            explainReporter.report('watcher', 'batch', `Batched ${sortedBatch.length} changes [${this.engine}]`);
            this.emit('change', sortedBatch);
        }, this.debounceMs);
    }

    close() {
        this.nativeWatcher?.stop?.();
        this.chokidarWatcher?.close?.();
    }
}
