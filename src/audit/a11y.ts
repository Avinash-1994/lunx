import type { Page } from 'puppeteer';
import { AuditGroup, AuditResult, AuditContext } from './types.js';
// axe-core is injected into the page by file path below and runs in the browser
// context, so a static import here only risked ERR_MODULE_NOT_FOUND: it is an
// optional peer, absent from a default install.
import fs from 'fs';
import path from 'path';

export class AccessibilityAudit {
    static async run(page: Page, context?: AuditContext): Promise<AuditGroup> {
        const results: AuditResult[] = [];

        // Inject axe-core into the page
        try {
            await page.addScriptTag({
                path: path.join(process.cwd(), 'node_modules/axe-core/axe.min.js')
            });

            // Run axe-core automated tests
            const axeResults = await page.evaluate(async () => {
                // @ts-ignore - axe is injected
                return await axe.run({
                    runOnly: {
                        type: 'tag',
                        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']
                    }
                });
            });

            // Process axe-core violations
            for (const violation of axeResults.violations) {
                const severity = violation.impact === 'critical' || violation.impact === 'serious' ? 'FAIL' : 'WARN';
                const score = severity === 'FAIL' ? 0 : 50;

                results.push({
                    id: `axe-${violation.id}`,
                    title: violation.help,
                    status: severity,
                    score,
                    details: `${violation.description}\nAffected elements: ${violation.nodes.length}\n${violation.nodes.slice(0, 3).map((n: any) => n.html).join('\n')}`,
                    fix: violation.helpUrl
                });
            }
        } catch (error: any) {
            // If axe-core fails, continue with basic checks
            console.warn('axe-core integration failed:', error.message);
        }

        // 1. HTML Lang Attribute
        const lang = await page.$eval('html', el => el.getAttribute('lang')).catch(() => null);
        results.push({
            id: 'html-lang',
            title: 'HTML has lang attribute',
            status: lang ? 'PASS' : 'FAIL',
            score: lang ? 100 : 0,
            details: lang ? `Lang attribute found: "${lang}"` : 'Missing lang attribute on <html>',
            fix: 'Add lang="en" (or appropriate language code) to <html> tag'
        });

        // 2. Images have alt text
        const failingImages = await page.$$eval('img', els => {
            return els
                .filter(el => !el.hasAttribute('alt') || el.getAttribute('alt') === '')
                .map(el => {
                    const src = el.getAttribute('src') || 'unknown';
                    const snippet = el.outerHTML.substring(0, 50) + '...';
                    return `Image: ${src} (Snippet: ${snippet})`;
                })
                .slice(0, 5);
        });

        results.push({
            id: 'img-alt',
            title: 'Images have alt text',
            status: failingImages.length === 0 ? 'PASS' : 'WARN',
            score: failingImages.length === 0 ? 100 : 50,
            details: failingImages.length === 0
                ? 'All images have alt text'
                : `Found images missing alt text:\n      ` + failingImages.join('\n      '),
            fix: 'Add descriptive alt="" attributes to all <img> tags'
        });

        // 3. Buttons have name/label
        const failingButtons = await page.$$eval('button', els => {
            return els.filter(el => {
                const text = el.innerText.trim();
                const ariaLabel = el.getAttribute('aria-label');
                const ariaLabelledBy = el.getAttribute('aria-labelledby');
                return !text && !ariaLabel && !ariaLabelledBy;
            }).map(el => {
                const id = el.id ? `#${el.id}` : '';
                const cls = el.className ? `.${el.className.split(' ').join('.')}` : '';
                return `Button: ${el.tagName.toLowerCase()}${id}${cls} (Snippet: ${el.outerHTML.substring(0, 50)}...)`;
            }).slice(0, 5);
        });

        results.push({
            id: 'button-name',
            title: 'Buttons have discernible text',
            status: failingButtons.length === 0 ? 'PASS' : 'FAIL',
            score: failingButtons.length === 0 ? 100 : 0,
            details: failingButtons.length === 0
                ? 'All buttons have text or aria-labels'
                : `Found buttons missing text/label:\n      ` + failingButtons.join('\n      '),
            fix: 'Add text content or aria-label to all <button> elements'
        });

        // 4. Form inputs have labels
        const failingInputs = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])'));
            return inputs.filter(input => {
                const id = input.id;
                const hasLabel = id && document.querySelector(`label[for="${id}"]`);
                const hasAria = input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby');
                return !hasLabel && !hasAria;
            }).map(input => {
                const i = input as HTMLInputElement;
                return `Input: type="${i.type}" name="${i.name}" id="${i.id}"`;
            }).slice(0, 5);
        });

        results.push({
            id: 'input-label',
            title: 'Form elements have labels',
            status: failingInputs.length === 0 ? 'PASS' : 'WARN',
            score: failingInputs.length === 0 ? 100 : 50,
            details: failingInputs.length === 0
                ? 'All inputs have associated labels'
                : `Found inputs missing labels:\n      ` + failingInputs.join('\n      '),
            fix: 'Add <label for="input-id"> or aria-label to all form inputs'
        });

        const score = Math.round(results.reduce((acc, r) => acc + r.score, 0) / results.length);

        return {
            name: 'Accessibility',
            results,
            score
        };
    }
}
