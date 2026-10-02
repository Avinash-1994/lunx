/**
 * Build diagnostics renderer.
 *
 * Previously an Ink (React) component, which made `react`, `react-dom`, `ink`,
 * `ink-spinner` and `chalk` runtime dependencies of the CLI. It now renders
 * plain ANSI strings, so a build tool no longer ships a UI framework.
 */

import colors from '../lib/colors.js';
import type { Warning } from './types.js';

export type { Warning };

export interface TerminalWarningsOptions {
    warnings: Warning[];
    isBuilding?: boolean;
    buildStage?: string;
    /** Frame index, used to advance the spinner between renders. */
    frame?: number;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

const SEVERITY = {
    critical: { icon: '🔴', label: 'CRITICAL', paint: colors.red },
    warning: { icon: '⚠️ ', label: 'WARNING', paint: colors.yellow },
    info: { icon: 'ℹ️ ', label: 'INFO', paint: colors.blue },
} as const;

export function spinnerFrame(frame: number): string {
    return SPINNER_FRAMES[Math.abs(frame) % SPINNER_FRAMES.length]!;
}

const INDENT = '   ';

/** Renders the diagnostics panel to a string. Callers decide where it goes. */
export function renderTerminalWarnings({
    warnings,
    isBuilding = false,
    buildStage = 'Building',
    frame = 0,
}: TerminalWarningsOptions): string {
    const lines: string[] = [];

    lines.push(colors.bold().cyan('⚡ Lunx Build Diagnostics'));
    lines.push('');

    if (isBuilding) {
        lines.push(colors.green(`${spinnerFrame(frame)} ${buildStage}...`));
        lines.push('');
    }

    if (warnings.length > 0) {
        const counts = { critical: 0, warning: 0, info: 0 };
        for (const w of warnings) counts[w.severity]++;

        const parts = [colors.dim(`Found ${warnings.length} issue${warnings.length === 1 ? '' : 's'}:`)];
        if (counts.critical > 0) parts.push(colors.red(`${counts.critical} critical`));
        if (counts.warning > 0) parts.push(colors.yellow(`${counts.warning} warning${counts.warning === 1 ? '' : 's'}`));
        if (counts.info > 0) parts.push(colors.blue(`${counts.info} info`));
        lines.push(parts.join(' '));
        lines.push('');
    }

    for (const warning of warnings) {
        const severity = SEVERITY[warning.severity];
        let header = `${severity.icon} ${colors.bold()[severityColor(warning.severity)](severity.label)}`;
        if (warning.category) header += colors.dim(` [${warning.category}]`);
        lines.push(header);
        lines.push(INDENT + warning.message);
        if (warning.file) {
            lines.push(INDENT + colors.dim(`at ${warning.file}${warning.line ? `:${warning.line}` : ''}`));
        }
        if (warning.fix) {
            lines.push(INDENT + colors.green('💡 Fix: ') + warning.fix);
        }
        lines.push('');
    }

    if (!isBuilding && warnings.length === 0) {
        lines.push(colors.green('✓ No issues found'));
    }

    // Single trailing blank line, whatever the branches above produced.
    while (lines.length > 1 && lines[lines.length - 1] === '' && lines[lines.length - 2] === '') lines.pop();

    return lines.map((line) => (line ? ` ${line}` : line)).join('\n');
}

function severityColor(severity: Warning['severity']): 'red' | 'yellow' | 'blue' {
    if (severity === 'critical') return 'red';
    if (severity === 'warning') return 'yellow';
    return 'blue';
}

/** Writes the panel to a stream (stdout by default). */
export function printTerminalWarnings(
    options: TerminalWarningsOptions,
    stream: NodeJS.WritableStream = process.stdout,
): void {
    stream.write(`${renderTerminalWarnings(options)}\n`);
}

export default renderTerminalWarnings;
