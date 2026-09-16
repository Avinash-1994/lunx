// TypeScript bindings for Tokio orchestrator — always load via the unified native loader.
import native, { getOptimalParallelism, benchmarkParallelism } from './index.js';

const NativeBuildOrchestrator = native.BuildOrchestrator;

export interface BuildEvent {
    stage: string;
    message: string;
    timestamp?: number;
    durationMs?: number;
    metadata?: string;
}

export interface OrchestratorStats {
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    totalDurationMs: number;
    parallelism: number;
}

type NativeBuildOrchestratorType = {
    logEvent(stage: string, message: string, durationMs?: number): Promise<void>;
    getEvents(): Promise<BuildEvent[]>;
    clearEvents(): Promise<void>;
    executeParallel(taskCount: number): Promise<OrchestratorStats>;
    processParallelSync(items: string[]): string[];
    generateStableId(content: string, prefix: string): string;
    batchGenerateIds(items: string[], prefix: string): string[];
    getStats(): Promise<OrchestratorStats>;
    parallelism: number;
    shutdown(): void;
};

/**
 * Tokio-based parallel build orchestrator
 */
export class BuildOrchestrator {
    private orchestrator: NativeBuildOrchestratorType;

    constructor(parallelism?: number) {
        this.orchestrator = new NativeBuildOrchestrator(parallelism);
    }

    async logEvent(stage: string, message: string, durationMs?: number): Promise<void> {
        await this.orchestrator.logEvent(stage, message, durationMs);
    }

    async getEvents(): Promise<BuildEvent[]> {
        return await this.orchestrator.getEvents();
    }

    async clearEvents(): Promise<void> {
        await this.orchestrator.clearEvents();
    }

    async executeParallel(taskCount: number): Promise<OrchestratorStats> {
        return await this.orchestrator.executeParallel(taskCount);
    }

    processParallelSync(items: string[]): string[] {
        return this.orchestrator.processParallelSync(items);
    }

    generateStableId(content: string, prefix: string): string {
        return this.orchestrator.generateStableId(content, prefix);
    }

    batchGenerateIds(items: string[], prefix: string): string[] {
        return this.orchestrator.batchGenerateIds(items, prefix);
    }

    async getStats(): Promise<OrchestratorStats> {
        return await this.orchestrator.getStats();
    }

    get parallelism(): number {
        return this.orchestrator.parallelism;
    }

    shutdown(): void {
        this.orchestrator.shutdown();
    }
}

export function getOptimalConcurrency(): number {
    return typeof getOptimalParallelism === 'function' ? getOptimalParallelism() : 1;
}

export function benchmarkConcurrency(itemCount: number): Record<string, number> {
    return typeof benchmarkParallelism === 'function' ? benchmarkParallelism(itemCount) : {};
}
