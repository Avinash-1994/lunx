/**
 * Type errors while you work (in place of vite-plugin-checker), with
 * `server: { typecheck: true }`: `lunx dev` runs the project's own TypeScript
 * (`vue-tsc` in a Vue project that has it) in watch mode, beside the dev
 * server, and reports each pass in the terminal and in the browser overlay.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';

export interface TypeError {
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
}

/** The checker's bin: vue-tsc for Vue (when installed), else tsc. Null without TypeScript or a tsconfig. */
export function findChecker(root: string, framework?: string): { bin: string; name: string; project: string } | null {
    const project = ['tsconfig.json', 'tsconfig.app.json'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
    if (!project) return null;
    const require = createRequire(path.join(root, 'package.json'));
    for (const [pkg, bin] of framework === 'vue' ? [['vue-tsc', 'bin/vue-tsc.js'], ['typescript', 'bin/tsc']] : [['typescript', 'bin/tsc']]) {
        try {
            return { bin: path.join(path.dirname(require.resolve(`${pkg}/package.json`)), bin!), name: pkg === 'vue-tsc' ? 'vue-tsc' : 'tsc', project };
        } catch {
            // not installed
        }
    }
    return null;
}

const ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
/** Colour codes, in case a checker colours its output despite `--pretty false`. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const PASS_END = /Found (\d+) errors?\b|Watching for file changes/;

/** Parses `tsc --pretty false` output, one pass at a time. */
export class TscOutput {
    private errors: TypeError[] = [];
    private buffer = '';

    constructor(private root: string, private onPass: (errors: TypeError[]) => void) {}

    push(chunk: string): void {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? '';
        for (const raw of lines) {
            const line = raw.replace(ANSI, '').replace(/^\[?\d{1,2}:\d{2}:\d{2}(?: [AP]M)?\]? - /, '');
            const m = ERROR.exec(line);
            if (m) {
                const file = path.resolve(this.root, m[1]!);
                this.errors.push({ file, line: Number(m[2]), column: Number(m[3]), code: m[4]!, message: m[5]! });
            } else if (/^\s+\S/.test(raw) && this.errors.length) {
                // The rest of a multi-line message.
                this.errors[this.errors.length - 1]!.message += '\n' + line.trim();
            } else if (PASS_END.test(line)) {
                const errors = this.errors;
                this.errors = [];
                this.onPass(errors);
            }
        }
    }
}

export interface TypecheckHandle {
    close(): void;
}

export async function startTypecheck(
    root: string,
    framework: string | undefined,
    report: (errors: TypeError[], checker: string) => void,
): Promise<TypecheckHandle | null> {
    const checker = findChecker(root, framework);
    if (!checker) return null;
    const { spawn } = await import('node:child_process');
    const child: ChildProcess = spawn(process.execPath, [checker.bin, '--noEmit', '--watch', '--pretty', 'false', '--preserveWatchOutput', '-p', checker.project], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = new TscOutput(root, (errors) => report(errors, checker.name));
    child.stdout!.setEncoding('utf8').on('data', (d: string) => output.push(d));
    child.stderr!.setEncoding('utf8').on('data', (d: string) => output.push(d));
    const stop = () => child.kill();
    process.once('exit', stop);
    return {
        close() {
            process.off('exit', stop);
            stop();
        },
    };
}
