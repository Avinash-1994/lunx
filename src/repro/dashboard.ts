import { RecordStore } from '../internal/store.js';
import { createHash } from 'crypto';
import type { BuildContext } from '../core/engine/types.js';
import type { RootCauseIssue } from '../visual/root-cause.js';
import { GitHubIntegration, type GitHubConfig } from './github.js';

/**
 * Repro Dashboard
 * Bug reproduction analysis and storage system
 */

export interface ReproCase {
    id: string;
    title: string;
    description: string;
    code: string;
    error?: string;
    stackTrace?: string;
    buildConfig?: any;
    analysis?: ReproAnalysis;
    createdAt: number;
    shareableLink?: string;
    githubIssueUrl?: string;
}

export interface ReproAnalysis {
    issues: RootCauseIssue[];
    suggestedFixes: string[];
    affectedModules: string[];
    analysisTime: number;
}

/** Persisted shape of a repro; mirrors the previous `repros` table columns. */
interface ReproRow {
    id: string;
    title: string;
    description: string;
    code: string;
    error: string | null;
    stack_trace: string | null;
    build_config: string | null;
    analysis: string | null;
    created_at: number;
    shareable_link: string;
    github_issue_url: string | null;
}

export class ReproDashboard {
    /**
     * Repro rows, stored as JSON rather than SQLite. The column names are kept
     * snake_case so the row -> ReproCase mapping below is unchanged.
     */
    private db: RecordStore<ReproRow> | null = null;
    private dbPath: string;
    private github: GitHubIntegration | null = null;

    constructor(dbPath: string = ':memory:', githubConfig?: GitHubConfig) {
        this.dbPath = dbPath;
        if (githubConfig) {
            this.github = new GitHubIntegration(githubConfig);
        }
    }

    /**
     * Initialize database
     */
    init(): void {
        this.db = new RecordStore<ReproRow>(this.dbPath);
    }

    /**
     * Submit a bug repro to GitHub
     */
    async submitToGitHub(reproId: string): Promise<string> {
        if (!this.github) {
            throw new Error('GitHub integration not configured');
        }

        const repro = this.getRepro(reproId);
        if (!repro) {
            throw new Error('Repro not found');
        }

        const body = this.github.formatIssueBody(
            repro.description,
            repro.code,
            { os: process.platform, node: process.version }
        );

        const result = await this.github.createIssue(repro.title, body);

        if (!result.success || !result.url) {
            throw new Error(result.error || 'Failed to create GitHub issue');
        }

        // Update database with issue URL
        const existing = this.db!.get(reproId);
        if (existing) this.db!.put({ ...existing, github_issue_url: result.url });

        return result.url;
    }

    /**
     * Submit a bug repro
     */
    submitRepro(repro: Omit<ReproCase, 'id' | 'createdAt' | 'shareableLink'>): string {
        if (!this.db) this.init();

        const id = this.generateReproId(repro.code);
        const createdAt = Date.now();
        const shareableLink = this.generateShareableLink(id);

        this.db!.put({
            id,
            title: repro.title,
            description: repro.description || '',
            code: repro.code,
            error: repro.error || null,
            stack_trace: repro.stackTrace || null,
            build_config: repro.buildConfig ? JSON.stringify(repro.buildConfig) : null,
            analysis: repro.analysis ? JSON.stringify(repro.analysis) : null,
            created_at: createdAt,
            shareable_link: shareableLink,
            github_issue_url: null,
        });

        return id;
    }

    /**
     * Analyze a repro case
     */
    async analyzeRepro(reproId: string, ctx?: BuildContext): Promise<ReproAnalysis> {
        const startTime = Date.now();

        const repro = this.getRepro(reproId);
        if (!repro) {
            throw new Error(`Repro ${reproId} not found`);
        }

        // Analyze the code for issues
        const issues: RootCauseIssue[] = [];
        const suggestedFixes: string[] = [];
        const affectedModules: string[] = [];

        // Parse error and suggest fixes
        if (repro.error) {
            if (repro.error.includes('Cannot find module')) {
                issues.push({
                    type: 'unused-dep',
                    severity: 'critical',
                    message: 'Module not found',
                    fix: 'Install the missing dependency or check the import path',
                    affectedNodes: []
                });
                suggestedFixes.push('npm install <missing-module>');
            }

            if (repro.error.includes('Unexpected token')) {
                issues.push({
                    type: 'dead-code',
                    severity: 'critical',
                    message: 'Syntax error detected',
                    fix: 'Check for syntax errors in the code',
                    affectedNodes: []
                });
                suggestedFixes.push('Review code syntax');
            }

            if (repro.error.includes('circular dependency')) {
                issues.push({
                    type: 'circular-dep',
                    severity: 'warning',
                    message: 'Circular dependency detected',
                    fix: 'Refactor to remove circular dependency',
                    affectedNodes: []
                });
                suggestedFixes.push('Refactor module structure');
            }
        }

        const analysisTime = Date.now() - startTime;

        const analysis: ReproAnalysis = {
            issues,
            suggestedFixes,
            affectedModules,
            analysisTime
        };

        // Store analysis
        this.updateReproAnalysis(reproId, analysis);

        return analysis;
    }

    /**
     * Get a repro case
     */
    getRepro(id: string): ReproCase | null {
        if (!this.db) this.init();

        const row = this.db!.get(id);

        if (!row) return null;

        return {
            id: row.id,
            title: row.title,
            description: row.description,
            code: row.code,
            error: row.error ?? undefined,
            stackTrace: row.stack_trace ?? undefined,
            buildConfig: row.build_config ? JSON.parse(row.build_config) : undefined,
            analysis: row.analysis ? JSON.parse(row.analysis) : undefined,
            createdAt: row.created_at,
            shareableLink: row.shareable_link,
            githubIssueUrl: row.github_issue_url ?? undefined
        };
    }

    /**
     * Get all repros
     */
    getAllRepros(): ReproCase[] {
        if (!this.db) this.init();

        const rows = this.db!.list({ sortBy: 'created_at', desc: true });

        return rows.map(row => ({
            id: row.id,
            title: row.title,
            description: row.description,
            code: row.code,
            error: row.error ?? undefined,
            stackTrace: row.stack_trace ?? undefined,
            buildConfig: row.build_config ? JSON.parse(row.build_config) : undefined,
            analysis: row.analysis ? JSON.parse(row.analysis) : undefined,
            createdAt: row.created_at,
            shareableLink: row.shareable_link,
            githubIssueUrl: row.github_issue_url ?? undefined
        }));
    }

    /**
     * Update repro analysis
     */
    private updateReproAnalysis(id: string, analysis: ReproAnalysis): void {
        if (!this.db) return;

        const existing = this.db.get(id);
        if (existing) this.db.put({ ...existing, analysis: JSON.stringify(analysis) });
    }

    /**
     * Generate repro ID
     */
    private generateReproId(code: string): string {
        const hash = createHash('sha256').update(code).digest('hex');
        return `repro-${hash.substring(0, 12)}`;
    }

    /**
     * Generate shareable link
     */
    private generateShareableLink(id: string): string {
        return `https://lunx.dev/repro/${id}`;
    }

    /**
     * Generate repro template
     */
    generateTemplate(framework: string = 'react'): string {
        const templates: Record<string, string> = {
            // Tier 1: Core Frameworks
            react: `import React from 'react';\nexport default function App() { return <div>Repro</div>; }`,
            vue: `<template><div>Repro</div></template>\n<script>export default { name: 'App' }</script>`,
            svelte: `<script>let name = 'Repro';</script>\n<div>{name}</div>`,

            // Tier 2: Performance
            solid: `import { createSignal } from 'solid-js';\nexport default function App() { return <div>Repro</div>; }`,
            preact: `import { h } from 'preact';\nexport default function App() { return <div>Repro</div>; }`,
            qwik: `import { component$ } from '@builder.io/qwik';\nexport default component$(() => <div>Repro</div>);`,

            // Tier 3: Enterprise
            angular: `@Component({ selector: 'app-root', template: '<div>Repro</div>' }) export class AppComponent {}`,

            // Tier 4: Native/Lightweight
            lit: `import { html, LitElement } from 'lit';\n@customElement('my-repro') class MyRepro extends LitElement { render() { return html\`<div>Repro</div>\`; } }`,
            alpine: `<div x-data="{ count: 0 }">Repro</div>`,
            astro: `--- \nconst name = "Repro"; \n---\n<div>{name}</div>`,
            stencil: `@Component({ tag: 'my-repro' }) export class MyRepro { render() { return <div>Repro</div>; } }`,

            // Fallback
            vanilla: `document.body.innerHTML = '<div>Repro</div>';`
        };

        return templates[framework] || templates.react;
    }

    /**
     * Replay a repro
     */
    async replayRepro(id: string): Promise<{ success: boolean; error?: string }> {
        const repro = this.getRepro(id);
        if (!repro) {
            return { success: false, error: 'Repro not found' };
        }

        try {
            // Simulate build with repro code
            // In production, this would actually run the build
            await new Promise(resolve => setTimeout(resolve, 100));

            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    /**
     * Close database connection
     */
    close(): void {
        // Nothing to close: writes are flushed synchronously on every mutation.
        this.db = null;
    }
}
