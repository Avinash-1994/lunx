import type { Page } from 'puppeteer';
import { AuditGroup, AuditResult, AuditContext } from './types.js';

export class PerformanceAudit {
    static async run(page: Page, context?: AuditContext): Promise<AuditGroup> {
        const results: AuditResult[] = [];

        // 1. Navigation Timing
        // Use evaluate to get metrics from the browser context
        const timing = await page.evaluate(() => {
            const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
            if (nav) {
                return {
                    loadEventEnd: nav.loadEventEnd,
                    startTime: nav.startTime,
                    domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
                    responseStart: nav.responseStart
                };
            }
            // Fallback
            const t = performance.timing;
            return {
                loadEventEnd: t.loadEventEnd - t.navigationStart,
                startTime: 0,
                domContentLoadedEventEnd: t.domContentLoadedEventEnd - t.navigationStart,
                responseStart: t.responseStart - t.navigationStart
            };
        });

        const loadTime = Math.max(0, Math.round(timing.loadEventEnd - timing.startTime));
        const domReady = Math.max(0, Math.round(timing.domContentLoadedEventEnd - timing.startTime));

        results.push({
            id: 'load-time',
            title: 'Page Load Time',
            status: loadTime < 2500 ? 'PASS' : loadTime < 4500 ? 'WARN' : 'FAIL',
            score: loadTime < 2500 ? 100 : loadTime < 4500 ? 50 : 0,
            details: `Fully loaded in ${loadTime}ms`
        });

        results.push({
            id: 'dom-ready',
            title: 'DOM Ready',
            status: domReady < 1500 ? 'PASS' : 'WARN',
            score: domReady < 1500 ? 100 : 50,
            details: `DOM Interactive in ${domReady}ms`
        });

        // 2. Resource Count
        const resourceCount = await page.evaluate(() => performance.getEntriesByType('resource').length);
        results.push({
            id: 'resource-count',
            title: 'Request Count',
            status: resourceCount < 50 ? 'PASS' : resourceCount < 100 ? 'WARN' : 'FAIL',
            score: resourceCount < 50 ? 100 : resourceCount < 100 ? 60 : 30,
            details: `${resourceCount} network requests`
        });

        // 3. CLS (Cumulative Layout Shift) Approximation - or just checks JS heap
        const jsHeap = await page.evaluate(() => (performance as any).memory?.usedJSHeapSize).catch(() => 0);
        if (jsHeap > 0) {
            const heapMB = Math.round(jsHeap / 1024 / 1024);
            results.push({
                id: 'js-heap',
                title: 'JS Heap Usage',
                status: heapMB < 50 ? 'PASS' : heapMB < 100 ? 'WARN' : 'FAIL',
                score: heapMB < 50 ? 100 : 50,
                details: `Used JS Heap: ${heapMB}MB`
            });
        }

        const score = Math.round(results.reduce((acc, r) => acc + r.score, 0) / results.length);

        return {
            name: 'Performance',
            results,
            score
        };
    }
}
