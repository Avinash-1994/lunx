import type { Page } from 'puppeteer';
import { AuditGroup, AuditResult, AuditContext } from './types.js';

export class SEOAudit {
    static async run(page: Page, context?: AuditContext): Promise<AuditGroup> {
        const results: AuditResult[] = [];

        // 1. Document Title
        const title = await page.title();
        results.push({
            id: 'meta-title',
            title: 'Document Title',
            status: title ? 'PASS' : 'FAIL',
            score: title ? 100 : 0,
            details: title ? `Title found: "${title.substring(0, 40)}${title.length > 40 ? '...' : ''}"` : 'Missing <title> tag'
        });

        // 2. Meta Description
        const metaDesc = await page.$eval('meta[name="description"]', el => el.getAttribute('content')).catch(() => null);
        results.push({
            id: 'meta-desc',
            title: 'Meta Description',
            status: metaDesc ? 'PASS' : 'WARN',
            score: metaDesc ? 100 : 50,
            details: metaDesc
                ? `Present (${metaDesc.length} chars)`
                : 'Missing <meta name="description">'
        });

        // 3. Heading Structure (H1)
        const h1Details = await page.$$eval('h1', els => els.map(el => el.innerText));
        const h1Count = h1Details.length;

        results.push({
            id: 'heading-structure',
            title: 'Heading Structure (H1)',
            status: h1Count === 1 ? 'PASS' : h1Count === 0 ? 'FAIL' : 'WARN',
            score: h1Count === 1 ? 100 : h1Count === 0 ? 0 : 50,
            details: h1Count === 1
                ? `Found 1 H1: "${h1Details[0]}"`
                : h1Count === 0
                    ? 'No H1 tags found'
                    : `Found ${h1Count} H1 tags (should be 1):\n      - ${h1Details.join('\n      - ')}`
        });

        // 4. Viewport
        const viewport = await page.$eval('meta[name="viewport"]', el => el.getAttribute('content')).catch(() => null);
        results.push({
            id: 'meta-viewport',
            title: 'Mobile Viewport',
            status: viewport ? 'PASS' : 'FAIL',
            score: viewport ? 100 : 0,
            details: viewport ? 'Viewport meta tag found' : 'Missing viewport meta tag'
        });

        // 5. Canonical Link
        const canonical = await page.$eval('link[rel="canonical"]', el => el.getAttribute('href')).catch(() => null);
        results.push({
            id: 'canonical',
            title: 'Canonical Link',
            status: canonical ? 'PASS' : 'WARN',
            score: canonical ? 100 : 50,
            details: canonical ? `Canonical: ${canonical}` : 'Missing canonical link (recommended)'
        });

        const score = Math.round(results.reduce((acc, r) => acc + r.score, 0) / results.length);

        return {
            name: 'SEO',
            results,
            score
        };
    }
}
