import type { Page } from 'puppeteer';

export type FrameworkType = 'react' | 'vue' | 'angular' | 'svelte' | 'solid' | 'vanilla';

export interface AuditContext {
    page: Page;
    url: string;
    framework: FrameworkType;
    lighthouseMode?: boolean;
    bundleAnalysis?: boolean;
}

export interface AuditResult {
    id: string;
    title: string;
    status: 'PASS' | 'FAIL' | 'WARN';
    score: number; // 0-100
    details: string;
    fix?: string; // Auto-fix suggestion (Module 5 Day 32)
}

export interface AuditGroup {
    name: string;
    results: AuditResult[];
    score: number; // Average score
}

export interface AuditReport {
    timestamp: number;
    duration?: number;
    url?: string;
    framework?: FrameworkType;
    overallScore?: number;
    groups: {
        a11y?: AuditGroup;
        perf?: AuditGroup;
        seo?: AuditGroup;
        bestPractices?: AuditGroup;
    };
}
