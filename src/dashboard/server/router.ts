
/**
 * Lunx Dashboard tRPC Router
 * Day 19: tRPC Dashboard Lock
 */

import { initTRPC } from '../../lib/rpc.js';
import { MetricsCollector } from '../metrics.js';
import { z } from '../../lib/schema.js';

const t = initTRPC.create();

const collector = MetricsCollector.getInstance();

export const dashboardRouter = t.router({
    // Live Metrics
    getMetrics: t.procedure.query(() => {
        return collector.getSummary();
    }),

    // Build History
    getHistory: t.procedure.query(() => {
        // We can expose the raw array or a slice
        // Accessing private 'builds' via generateReport logic or similar accessor.
        // We'll trust generateReport for full data or rely on memory reference if we exposed it.
        // For type safety, we'll return summary + last build ID.
        const summary = collector.getSummary();
        return {
            metrics: summary,
            status: summary.errors > 0 ? 'unstable' : 'healthy'
        };
    }),

    // Generate Shareable Report
    generateReport: t.procedure.mutation(() => {
        return collector.generateReport();
    }),

    // Trigger Audit (Simulation)
    runAudit: t.procedure.mutation(async () => {
        // Simulate an audit running
        await new Promise(r => setTimeout(r, 50));
        return { score: 98, issues: [] };
    })
});

export type DashboardRouter = typeof dashboardRouter;
