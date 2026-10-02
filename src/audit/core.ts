/**
 * Module 5 Day 29: Enhanced Audit Engine Core
 * 
 * Features:
 * - Parallel Puppeteer workers for faster audits
 * - axe-core integration for comprehensive A11y
 * - Lighthouse integration for performance
 * - Framework-aware auditing (React, Vue, Angular)
 * - BundlePhobia integration for bundle analysis
 */

import type { Browser, Page } from 'puppeteer';
import { loadPuppeteer } from './puppeteer.js';
import path from 'path';
import { AccessibilityAudit } from './a11y.js';
import { PerformanceAudit } from './perf.js';
import { SEOAudit } from './seo.js';
import { BestPracticesAudit } from './best-practices.js';
import { AuditReport, AuditContext, FrameworkType, AuditResult } from './types.js';
import { log } from '../utils/logger.js';

export interface AuditOptions {
    parallel?: boolean;
    framework?: FrameworkType;
    bundleAnalysis?: boolean;
    lighthouseMode?: boolean;
    timeout?: number;
}

export class AuditEngine {
    private static workerPool: Browser[] = [];
    private static readonly MAX_WORKERS = 3;

    /**
     * Initialize worker pool for parallel audits
     */
    static async initWorkerPool(): Promise<void> {
        if (this.workerPool.length > 0) return;

        log.info('🚀 Initializing audit worker pool...');

        for (let i = 0; i < this.MAX_WORKERS; i++) {
            const browser = await (await loadPuppeteer()).launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // Prevent memory issues in CI
                    '--disable-gpu'
                ]
            });
            this.workerPool.push(browser);
        }

        log.info(`✅ Worker pool initialized with ${this.MAX_WORKERS} workers`);
    }

    /**
     * Cleanup worker pool
     */
    static async cleanupWorkerPool(): Promise<void> {
        for (const browser of this.workerPool) {
            await browser.close();
        }
        this.workerPool = [];
    }

    /**
     * Get an available worker from the pool
     */
    private static async getWorker(): Promise<Browser> {
        if (this.workerPool.length === 0) {
            await this.initWorkerPool();
        }
        return this.workerPool[0]; // Simple round-robin can be improved
    }

    /**
     * Detect framework from page content
     */
    private static async detectFramework(page: Page): Promise<FrameworkType> {
        const framework = await page.evaluate(() => {
            // Check for React
            if ((window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__) return 'react';
            if ((window as any).React) return 'react';

            // Check for Vue
            if ((window as any).__VUE__) return 'vue';
            if ((window as any).Vue) return 'vue';

            // Check for Angular
            if ((window as any).ng) return 'angular';
            if ((window as any).getAllAngularRootElements) return 'angular';

            // Check for Svelte
            if (document.querySelector('[data-svelte]')) return 'svelte';

            // Check for Solid
            if ((window as any)._$HY) return 'solid';

            return 'vanilla';
        });

        return framework as FrameworkType;
    }

    /**
     * Run all audits with enhanced features
     */
    static async runAll(urlOrPath: string, options: AuditOptions = {}): Promise<AuditReport> {
        const {
            parallel = true,
            framework: userFramework,
            bundleAnalysis = false,
            lighthouseMode = false,
            timeout = 30000
        } = options;

        let targetUrl = urlOrPath;

        // Handle file paths
        if (!urlOrPath.startsWith('http')) {
            if (!path.isAbsolute(urlOrPath)) {
                targetUrl = path.resolve(process.cwd(), urlOrPath);
            }
            if (!targetUrl.endsWith('.html')) {
                targetUrl = path.join(targetUrl, 'index.html');
            }
            targetUrl = 'file://' + targetUrl;
        }

        log.info(`🔍 Starting enhanced audit for ${targetUrl}...`);

        const browser = parallel ? await this.getWorker() : await (await loadPuppeteer()).launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        try {
            const page = await browser.newPage();

            // Set viewport
            await page.setViewport({ width: 1280, height: 800 });

            // Navigate
            await page.goto(targetUrl, {
                waitUntil: 'networkidle0',
                timeout
            });

            log.info('✅ Page loaded. Analyzing...');

            // Detect framework
            const detectedFramework = userFramework || await this.detectFramework(page);
            log.info(`📦 Framework detected: ${detectedFramework}`);

            // Create audit context
            const context: AuditContext = {
                page,
                url: targetUrl,
                framework: detectedFramework,
                lighthouseMode,
                bundleAnalysis
            };

            // Run audits in parallel
            const startTime = Date.now();
            const [a11y, perf, seo, bestPractices] = await Promise.all([
                AccessibilityAudit.run(page, context),
                PerformanceAudit.run(page, context),
                SEOAudit.run(page, context),
                BestPracticesAudit.run(page, context)
            ]);
            const duration = Date.now() - startTime;

            log.info(`✅ Audit completed in ${duration}ms`);

            // Calculate overall score (weighted average)
            const overallScore = Math.round(
                (a11y.score * 0.25) +
                (perf.score * 0.35) +
                (seo.score * 0.20) +
                (bestPractices.score * 0.20)
            );

            return {
                timestamp: Date.now(),
                duration,
                url: targetUrl,
                framework: detectedFramework,
                overallScore,
                groups: {
                    a11y,
                    perf,
                    seo,
                    bestPractices
                }
            };
        } catch (e: any) {
            log.error('❌ Audit execution failed:', e.message);
            throw e;
        } finally {
            if (!parallel) {
                await browser.close();
            }
        }
    }

    /**
     * Run framework-specific audits
     */
    static async runFrameworkAudit(
        urlOrPath: string,
        framework: FrameworkType
    ): Promise<AuditReport> {
        log.info(`🎯 Running ${framework}-specific audit...`);

        const report = await this.runAll(urlOrPath, { framework });

        // Add framework-specific results to the report
        const frameworkResults: AuditResult[] = [];

        if (framework === 'react') {
            // Check for React hydration issues
            log.info('  - Checking React hydration...');

            const hydrationCheck = await this.checkReactHydration(report.url!);
            frameworkResults.push(hydrationCheck);

        } else if (framework === 'vue') {
            // Check for Vue SSR issues
            log.info('  - Checking Vue SSR...');

            const ssrCheck = await this.checkVueSSR(report.url!);
            frameworkResults.push(ssrCheck);

        } else if (framework === 'angular') {
            // Check for Angular Ivy optimizations
            log.info('  - Checking Angular Ivy...');

            const ivyCheck = await this.checkAngularIvy(report.url!);
            frameworkResults.push(ivyCheck);
        }

        // Add framework-specific results to best practices
        if (frameworkResults.length > 0 && report.groups.bestPractices) {
            report.groups.bestPractices.results.push(...frameworkResults);
            // Recalculate score
            report.groups.bestPractices.score = Math.round(
                report.groups.bestPractices.results.reduce((acc, r) => acc + r.score, 0) /
                report.groups.bestPractices.results.length
            );
        }

        return report;
    }

    /**
     * Check React hydration issues
     */
    private static async checkReactHydration(url: string): Promise<AuditResult> {
        const browser = await this.getWorker();
        const page = await browser.newPage();

        try {
            await page.goto(url, { waitUntil: 'networkidle0' });

            const hydrationIssues = await page.evaluate(() => {
                // Check for hydration mismatch warnings in console
                const issues: string[] = [];

                // Check if React DevTools hook exists
                if (!(window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__) {
                    issues.push('React DevTools hook not found');
                }

                // Check for common hydration issues
                const suspiciousElements = document.querySelectorAll('[data-reactroot]');
                if (suspiciousElements.length > 1) {
                    issues.push(`Multiple React roots detected: ${suspiciousElements.length}`);
                }

                return issues;
            });

            return {
                id: 'react-hydration',
                title: 'React Hydration Check',
                status: hydrationIssues.length === 0 ? 'PASS' : 'WARN',
                score: hydrationIssues.length === 0 ? 100 : 70,
                details: hydrationIssues.length === 0
                    ? 'No hydration issues detected'
                    : `Potential issues: ${hydrationIssues.join(', ')}`,
                fix: 'Ensure server and client render the same content'
            };
        } finally {
            await page.close();
        }
    }

    /**
     * Check Vue SSR issues
     */
    private static async checkVueSSR(url: string): Promise<AuditResult> {
        const browser = await this.getWorker();
        const page = await browser.newPage();

        try {
            await page.goto(url, { waitUntil: 'networkidle0' });

            const ssrIssues = await page.evaluate(() => {
                const issues: string[] = [];

                // Check if Vue is present
                if (!(window as any).__VUE__ && !(window as any).Vue) {
                    issues.push('Vue instance not found');
                }

                // Check for SSR attributes
                const ssrElements = document.querySelectorAll('[data-server-rendered]');
                if (ssrElements.length === 0) {
                    issues.push('No SSR markers found');
                }

                return issues;
            });

            return {
                id: 'vue-ssr',
                title: 'Vue SSR Check',
                status: ssrIssues.length === 0 ? 'PASS' : 'WARN',
                score: ssrIssues.length === 0 ? 100 : 70,
                details: ssrIssues.length === 0
                    ? 'Vue SSR configured correctly'
                    : `Potential issues: ${ssrIssues.join(', ')}`,
                fix: 'Ensure Vue SSR is properly configured with data-server-rendered attribute'
            };
        } finally {
            await page.close();
        }
    }

    /**
     * Check Angular Ivy optimizations
     */
    private static async checkAngularIvy(url: string): Promise<AuditResult> {
        const browser = await this.getWorker();
        const page = await browser.newPage();

        try {
            await page.goto(url, { waitUntil: 'networkidle0' });

            const ivyIssues = await page.evaluate(() => {
                const issues: string[] = [];

                // Check if Angular is present
                if (!(window as any).ng && !(window as any).getAllAngularRootElements) {
                    issues.push('Angular instance not found');
                }

                // Check for Ivy-specific markers
                const ngElements = document.querySelectorAll('[ng-version]');
                if (ngElements.length === 0) {
                    issues.push('No Angular version markers found');
                }

                return issues;
            });

            return {
                id: 'angular-ivy',
                title: 'Angular Ivy Check',
                status: ivyIssues.length === 0 ? 'PASS' : 'WARN',
                score: ivyIssues.length === 0 ? 100 : 70,
                details: ivyIssues.length === 0
                    ? 'Angular Ivy optimizations detected'
                    : `Potential issues: ${ivyIssues.join(', ')}`,
                fix: 'Ensure Angular Ivy is enabled in tsconfig.json'
            };
        } finally {
            await page.close();
        }
    }

    /**
     * Get Lighthouse correlation score (for validation)
     */
    static calculateLighthouseCorrelation(report: AuditReport): number {
        // Lighthouse uses similar categories with different weights
        // Our correlation target is >95%
        const lighthouseEquivalent = Math.round(
            (report.groups.perf?.score || 0) * 0.40 +
            (report.groups.a11y?.score || 0) * 0.25 +
            (report.groups.bestPractices?.score || 0) * 0.20 +
            (report.groups.seo?.score || 0) * 0.15
        );

        return lighthouseEquivalent;
    }
}
