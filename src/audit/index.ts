import { loadPuppeteer } from './puppeteer.js';
import path from 'path';
import { AccessibilityAudit } from './a11y.js';
import { PerformanceAudit } from './perf.js';
import { SEOAudit } from './seo.js';
import { BestPracticesAudit } from './best-practices.js';
import { AuditReport } from './types.js';

export class AuditEngine {
    static async runAll(urlOrPath: string): Promise<AuditReport> {
        let targetUrl = urlOrPath;

        // Handle file paths
        if (!urlOrPath.startsWith('http')) {
            if (!path.isAbsolute(urlOrPath)) {
                targetUrl = path.resolve(process.cwd(), urlOrPath);
            }
            // If it's a directory, try index.html, unless it's a file
            if (!targetUrl.endsWith('.html')) {
                targetUrl = path.join(targetUrl, 'index.html');
            }
            targetUrl = 'file://' + targetUrl;
        }

        console.log(`ℹ [AUDIT] Launching browser for ${targetUrl}...`);

        const browser = await (await loadPuppeteer()).launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'] // Critical for CI environments
        });

        try {
            const page = await browser.newPage();

            // Set a standard viewport
            await page.setViewport({ width: 1280, height: 800 });

            // Navigate
            await page.goto(targetUrl, {
                waitUntil: 'networkidle0',
                timeout: 30000
            });

            console.log('ℹ [AUDIT] Page loaded. Analyzing...');

            const [a11y, perf, seo, bestPractices] = await Promise.all([
                AccessibilityAudit.run(page),
                PerformanceAudit.run(page),
                SEOAudit.run(page),
                BestPracticesAudit.run(page)
            ]);

            return {
                timestamp: Date.now(),
                groups: {
                    a11y,
                    perf,
                    seo,
                    bestPractices
                }
            };
        } catch (e) {
            console.error('❌ Audit execution failed:', e);
            throw e;
        } finally {
            await browser.close();
        }
    }
}
