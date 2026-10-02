import { WebSocket } from '../lib/ws.js';
import { log } from '../utils/logger.js';

interface HMRUpdate {
    type: string;
    path: string;
    timestamp: number;
}

interface ClientState {
    pendingUpdates: Set<string>;
    isProcessing: boolean;
    lastUpdate: number;
}

export class HMRThrottle {
    private pendingUpdates = new Map<string, HMRUpdate>();
    private clientStates = new Map<WebSocket, ClientState>();
    private debounceTimer: NodeJS.Timeout | null = null;
    private readonly DEBOUNCE_MS = 50;

    constructor(private broadcast: (msg: string) => void) { }

    registerClient(ws: WebSocket) {
        this.clientStates.set(ws, {
            pendingUpdates: new Set(),
            isProcessing: false,
            lastUpdate: Date.now()
        });
    }

    unregisterClient(ws: WebSocket) {
        this.clientStates.delete(ws);
    }

    queueUpdate(path: string, type: string = 'reload') {
        // Deduplicate updates for the same file
        this.pendingUpdates.set(path, {
            type,
            path,
            timestamp: Date.now()
        });

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.flushUpdates();
        }, this.DEBOUNCE_MS);
    }

    private flushUpdates() {
        if (this.pendingUpdates.size === 0) return;

        const updates = Array.from(this.pendingUpdates.values());
        this.pendingUpdates.clear();
        this.debounceTimer = null;

        log.info(`Flushing ${updates.length} HMR updates`, { category: 'hmr' });

        // If multiple files changed, we might want to send a full reload or a batch
        // For now, let's send individual updates but batched in time
        // Or better, send a batch message if the client supports it.
        // Since our client currently expects single messages, we'll iterate.
        // BUT, if we have too many, we should just reload.

        if (updates.length > 10) {
            log.warn('Too many updates, triggering full reload', { category: 'hmr' });
            this.broadcast(JSON.stringify({ type: 'full-reload' }));
            return;
        }

        // Group regular updates into a single 'update' message
        const jsModules = updates.filter(u => u.type === 'update').map(u => u.path);
        if (jsModules.length > 0) {
            this.broadcast(JSON.stringify({ type: 'update', modules: jsModules }));
        }

        // Handle CSS and full reloads
        updates.forEach(update => {
            if (update.type === 'css-update') {
                this.broadcast(JSON.stringify({ type: 'css-update', href: update.path }));
            } else if (update.type === 'full-reload') {
                this.broadcast(JSON.stringify({ type: 'full-reload' }));
            }
        });
    }
}
