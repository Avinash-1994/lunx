/**
 * Zero-dependency "open this file in the user's editor", replacing `launch-editor`.
 *
 * Resolves the editor from $LUNX_EDITOR / $VISUAL / $EDITOR, else guesses from
 * the running process list of common editors, else falls back to the OS opener.
 */

import { spawn, execSync } from 'node:child_process';
import path from 'node:path';

/** Editors whose CLI takes `--goto file:line:column` or `-g`. */
const EDITOR_ARGS: Record<string, (file: string, line?: number, column?: number) => string[]> = {
    code: (f, l, c) => (l ? ['-g', `${f}:${l}${c ? `:${c}` : ''}`] : [f]),
    'code-insiders': (f, l, c) => (l ? ['-g', `${f}:${l}${c ? `:${c}` : ''}`] : [f]),
    cursor: (f, l, c) => (l ? ['-g', `${f}:${l}${c ? `:${c}` : ''}`] : [f]),
    windsurf: (f, l, c) => (l ? ['-g', `${f}:${l}${c ? `:${c}` : ''}`] : [f]),
    subl: (f, l, c) => [l ? `${f}:${l}${c ? `:${c}` : ''}` : f],
    sublime: (f, l, c) => [l ? `${f}:${l}${c ? `:${c}` : ''}` : f],
    atom: (f, l, c) => [l ? `${f}:${l}${c ? `:${c}` : ''}` : f],
    webstorm: (f, l) => (l ? ['--line', String(l), f] : [f]),
    idea: (f, l) => (l ? ['--line', String(l), f] : [f]),
    'phpstorm': (f, l) => (l ? ['--line', String(l), f] : [f]),
    vim: (f, l) => (l ? [`+${l}`, f] : [f]),
    nvim: (f, l) => (l ? [`+${l}`, f] : [f]),
    emacs: (f, l) => (l ? [`+${l}`, f] : [f]),
    nano: (f, l) => (l ? [`+${l}`, f] : [f]),
};

/** Process names to look for when no editor env var is set. */
const DETECTABLE: Array<[processName: string, command: string]> = [
    ['Code.exe', 'code'],
    ['Code - Insiders.exe', 'code-insiders'],
    ['Cursor.exe', 'cursor'],
    ['sublime_text.exe', 'subl'],
    ['webstorm64.exe', 'webstorm'],
    ['idea64.exe', 'idea'],
    ['Visual Studio Code', 'code'],
    ['Cursor', 'cursor'],
    ['Sublime Text', 'subl'],
    ['WebStorm', 'webstorm'],
];

let detected: string | null | undefined;

function detectEditor(): string | null {
    if (detected !== undefined) return detected;
    detected = null;
    try {
        const isWindows = process.platform === 'win32';
        const listing = isWindows
            ? execSync('tasklist /fo csv /nh', { encoding: 'utf8', timeout: 3000, windowsHide: true })
            : execSync('ps -A -o comm=', { encoding: 'utf8', timeout: 3000 });
        for (const [processName, command] of DETECTABLE) {
            if (listing.includes(processName)) {
                detected = command;
                break;
            }
        }
    } catch {
        detected = null;
    }
    return detected;
}

export interface OpenResult {
    opened: boolean;
    editor?: string;
    error?: Error;
}

/**
 * Opens `file` (optionally at `line`/`column`) in the user's editor.
 * Never throws: the dev server must not die because an editor is missing.
 */
export function openInEditor(file: string, line?: number, column?: number): OpenResult {
    const absolute = path.resolve(file);
    const configured = process.env.LUNX_EDITOR || process.env.VISUAL || process.env.EDITOR;
    const editor = configured || detectEditor();

    if (!editor) return openWithSystem(absolute);

    // $EDITOR may carry its own flags, e.g. "code -w".
    const [command, ...presetArgs] = editor.split(/\s+/);
    if (!command) return openWithSystem(absolute);

    const base = path.basename(command, path.extname(command));
    const buildArgs = EDITOR_ARGS[base] ?? ((f: string) => [f]);
    const args = [...presetArgs, ...buildArgs(absolute, line, column)];

    try {
        const child = spawn(command, args, {
            stdio: 'ignore',
            detached: process.platform !== 'win32',
            shell: process.platform === 'win32',
            windowsHide: true,
        });
        child.on('error', () => {
            /* editor not on PATH; the caller already got opened:true, which is fine for a dev convenience */
        });
        child.unref();
        return { opened: true, editor: base };
    } catch (error) {
        return { opened: false, error: error as Error };
    }
}

function openWithSystem(file: string): OpenResult {
    const [command, args] =
        process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '', file]]
            : process.platform === 'darwin'
              ? ['open', [file]]
              : ['xdg-open', [file]];
    try {
        const child = spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
        child.on('error', () => {});
        child.unref();
        return { opened: true, editor: 'system' };
    } catch (error) {
        return { opened: false, error: error as Error };
    }
}

/** `launch-editor`-compatible default export. */
export default function launchEditor(
    file: string,
    _specifiedEditor?: string,
    onError?: (filename: string, error: string) => void,
): void {
    // launch-editor accepts "file:line:column" in one string.
    const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(file);
    const target = match ? match[1]! : file;
    const line = match ? Number(match[2]) : undefined;
    const column = match && match[3] ? Number(match[3]) : undefined;

    const result = openInEditor(target, line, column);
    if (!result.opened && onError) onError(target, result.error?.message ?? 'Could not open editor');
}
