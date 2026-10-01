import type { Page } from 'puppeteer';
import { AuditGroup, AuditResult, AuditContext } from './types.js';

export class BestPracticesAudit {
    static async run(page: Page, context?: AuditContext): Promise<AuditGroup> {
        const results: AuditResult[] = [];

        // 1. Doctype
        const hasDoctype = await page.evaluate(() => document.doctype !== null);
        results.push({
            id: 'doctype',
            title: 'Uses HTML5 Doctype',
            status: hasDoctype ? 'PASS' : 'FAIL',
            score: hasDoctype ? 100 : 0,
            details: hasDoctype ? 'Page has a DOCTYPE' : 'Missing DOCTYPE'
        });

        // 2. HTTPS (Skip for localhost)
        const url = page.url();
        const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
        const isHttps = url.startsWith('https:');

        results.push({
            id: 'https',
            title: 'Uses HTTPS',
            status: isHttps || isLocal ? 'PASS' : 'WARN',
            score: isHttps || isLocal ? 100 : 50,
            details: isHttps ? 'Secure (HTTPS)' : isLocal ? 'Localhost (HTTP allowed)' : 'Insecure (HTTP)'
        });

        // 3. Safe External Links
        // Check a[target="_blank"] for rel="noopener" or "noreferrer"
        const unsafeLinks = await page.$$eval('a[target="_blank"]', els => {
            return els.filter(el => {
                const rel = el.getAttribute('rel') || '';
                return !rel.includes('noopener') && !rel.includes('noreferrer');
            }).map(el => {
                return `Link: ${el.innerText.substring(0, 20)} -> ${el.getAttribute('href')}`;
            }).slice(0, 5);
        });

        results.push({
            id: 'safe-links',
            title: 'Safe External Links',
            status: unsafeLinks.length === 0 ? 'PASS' : 'WARN',
            score: unsafeLinks.length === 0 ? 100 : 50,
            details: unsafeLinks.length === 0
                ? 'All external links are safe'
                : `Unsafe links (missing rel="noopener"):\n      ` + unsafeLinks.join('\n      ')
        });

        // 4. Image Aspect Ratio
        const invalidImages = await page.$$eval('img', els => {
            return els.filter(el => !el.hasAttribute('width') || !el.hasAttribute('height'))
                .map(el => {
                    const src = el.getAttribute('src');
                    return `Image: ${src}`;
                })
                .slice(0, 5);
        });

        results.push({
            id: 'image-dimensions',
            title: 'Image Dimensions',
            status: invalidImages.length === 0 ? 'PASS' : 'WARN',
            score: invalidImages.length === 0 ? 100 : 70,
            details: invalidImages.length === 0
                ? 'All images have width/height'
                : `Images missing dimensions:\n      ` + invalidImages.join('\n      ')
        });

        const score = Math.round(results.reduce((acc, r) => acc + r.score, 0) / results.length);

        return {
            name: 'Best Practices',
            results,
            score
        };
    }
}
