import path from 'path';
import { RecordStore } from '../../internal/store.js';
import { LearnedError } from '../core/errorMemory.js';
import { FixAction } from '../healer/fixer.js';

interface ErrorRow {
    id: string;
    signature: string;
    type: string;
    context: string;
    timestamp: number;
}

interface FixRow {
    id: string;
    error_id: string;
    recipe: string;
    success_count: number;
    fail_count: number;
    last_used: number;
}

/**
 * Persistent store for learned errors and the fixes that resolved them.
 *
 * Backed by two small JSON collections rather than SQLite -- the data is a few
 * hundred rows and never needed joins, so the native addon was pure install
 * cost. See `src/internal/store.ts`.
 */
export class FixStore {
    private readonly errors: RecordStore<ErrorRow>;
    private readonly fixes: RecordStore<FixRow>;

    constructor(rootDir: string) {
        const dbDir = path.join(rootDir, '.lunx');
        this.errors = new RecordStore<ErrorRow>(path.join(dbDir, 'ai-errors.json'));
        this.fixes = new RecordStore<FixRow>(path.join(dbDir, 'ai-fixes.json'));
    }

    saveError(error: LearnedError) {
        // INSERT OR IGNORE: an error we have already learned keeps its first record.
        if (this.errors.has(error.id)) return;
        this.errors.put({
            id: error.id,
            signature: error.signature,
            type: error.type,
            context: JSON.stringify(error.context),
            timestamp: error.timestamp,
        });
    }

    saveFix(errorId: string, fix: FixAction) {
        const fixId = this.generateFixId(errorId, fix);
        if (this.fixes.has(fixId)) return fixId;
        this.fixes.put({
            id: fixId,
            error_id: errorId,
            recipe: JSON.stringify(fix),
            success_count: 0,
            fail_count: 0,
            last_used: Date.now(),
        });
        return fixId;
    }

    findFixes(errorId: string): FixAction[] {
        // Score = success / (success + fail); favours fixes that have worked.
        return this.fixes
            .find((row) => row.error_id === errorId)
            .sort(
                (a, b) =>
                    this.calculateScore(b.success_count, b.fail_count) -
                    this.calculateScore(a.success_count, a.fail_count),
            )
            .map((row) => JSON.parse(row.recipe) as FixAction);
    }

    private calculateScore(success: number, fail: number): number {
        const total = success + fail;
        if (total === 0) return 0;
        return success / total; // Simple ratio for now
    }

    recordOutcome(fixId: string, success: boolean) {
        const row = this.fixes.get(fixId);
        if (!row) return;
        this.fixes.put({
            ...row,
            success_count: row.success_count + (success ? 1 : 0),
            fail_count: row.fail_count + (success ? 0 : 1),
            last_used: Date.now(),
        });
    }

    private generateFixId(errorId: string, fix: FixAction): string {
        // Simple hash of errorId + fix content
        const content = errorId + JSON.stringify(fix);
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(16);
    }

    getStats() {
        return {
            errors: this.errors.count(),
            fixes: this.fixes.count(),
            successfulFixes: this.fixes.sum('success_count'),
        };
    }

    deleteError(errorId: string) {
        this.fixes.deleteWhere((row) => row.error_id === errorId);
        this.errors.delete(errorId);
    }
}
