
import readline from 'readline';
import kleur from '../lib/colors.js';

type Key = {
    name: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
};

const lineBuffer: string[] = [];
let pendingResolve: ((val: string) => void) | null = null;
let pipedInited = false;
let sharedRL: readline.Interface | null = null;

function initPipedInput() {
    if (pipedInited) return;
    pipedInited = true;
    sharedRL = readline.createInterface({
        input: process.stdin,
        terminal: false
    });
    sharedRL.on('line', (line) => {
        if (pendingResolve) {
            const res = pendingResolve;
            pendingResolve = null;
            res(line);
        } else {
            lineBuffer.push(line);
        }
    });
}

function readLineFromPipe(): Promise<string> {
    initPipedInput();
    if (lineBuffer.length > 0) {
        return Promise.resolve(lineBuffer.shift()!);
    }
    return new Promise((resolve) => {
        pendingResolve = resolve;
    });
}

function onKeyPress(callback: (str: string, key: Key) => void) {
    readline.emitKeypressEvents(process.stdin);
    const handler = (str: string, key: Key) => {
        if (key && key.ctrl && key.name === 'c') {
            process.exit(0);
        }
        callback(str, key);
    };
    process.stdin.on('keypress', handler);
    return () => {
        process.stdin.off('keypress', handler);
    };
}

export function closeUI() {
    if (sharedRL) {
        sharedRL.close();
        sharedRL = null;
    }
    pipedInited = false;
}

function cleanup() {
    if (process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
        (process.stdin as any).setRawMode(false);
    }
}

/**
 * Interactive Text Input
 */
export async function text(question: string, initial: string = ''): Promise<string> {
    const forceFallback = process.env.LUNX_NON_INTERACTIVE === 'true';
    if (!forceFallback && process.stdin.isTTY) {
        return new Promise((resolve) => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            rl.question(`${kleur.cyan(question)} ${kleur.dim(`(${initial})`)} `, (answer) => {
                rl.close();
                resolve(answer || initial);
            });
        });
    } else {
        process.stdout.write(`${question} (${initial}): `);
        const answer = await readLineFromPipe();
        return answer || initial;
    }
}

/**
 * Interactive Select (Radio)
 */
export async function select<T extends string>(question: string, options: T[]): Promise<T> {
    const forceFallback = process.env.LUNX_NON_INTERACTIVE === 'true';
    if (!forceFallback && process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
        return new Promise((resolve) => {
            let index = 0;
            const render = (clear = false) => {
                if (clear) {
                    process.stdout.write(`\x1b[${options.length}A`);
                }

                options.forEach((opt, i) => {
                    const isSelected = i === index;
                    const icon = isSelected ? kleur.green('❯') : ' ';
                    const label = isSelected ? kleur.cyan().bold(opt) : opt;
                    const shortcut = i < 9 ? kleur.dim(`(${i + 1})`) : '';
                    process.stdout.write(`\x1b[2K\r  ${icon} ${label} ${shortcut}\n`);
                });
            };

            console.log(`${kleur.bold(question)}`);
            (process.stdin as any).setRawMode(true);
            process.stdin.resume();
            render();

            const cleanupListener = onKeyPress((_str, key) => {
                if (key.name === 'up' || key.name === 'k') {
                    index = (index - 1 + options.length) % options.length;
                    render(true);
                } else if (key.name === 'down' || key.name === 'j') {
                    index = (index + 1) % options.length;
                    render(true);
                } else if (key.name === 'return') {
                    cleanupListener();
                    cleanup();
                    resolve(options[index]);
                } else if (/[1-9]/.test(key.name)) {
                    const num = parseInt(key.name) - 1;
                    if (num >= 0 && num < options.length) {
                        index = num;
                        render(true);
                    }
                }
            });
        });
    } else {
        options.forEach((opt, i) => console.log(`  [${i + 1}] ${opt}`));
        process.stdout.write(`${question} Choose (1-${options.length}): `);
        const answer = await readLineFromPipe();
        const idx = parseInt(answer) - 1;
        return options[idx] || options[0];
    }
}

/**
 * Interactive MultiSelect (Checkbox)
 */
export async function multiselect<T extends string>(question: string, options: T[], defaults: boolean[] = []): Promise<T[]> {
    const forceFallback = process.env.LUNX_NON_INTERACTIVE === 'true';
    if (!forceFallback && process.stdin.isTTY && typeof (process.stdin as any).setRawMode === 'function') {
        return new Promise((resolve) => {
            let index = 0;
            const selected = new Set<number>();

            options.forEach((_, i) => {
                if (defaults[i]) selected.add(i);
            });

            const render = (clear = false) => {
                if (clear) {
                    process.stdout.write(`\x1b[${options.length + 1}A`);
                }

                process.stdout.write(`\x1b[2K\r${kleur.dim('(Press <space> to select, <enter> to confirm)')}\n`);

                options.forEach((opt, i) => {
                    const isFocused = i === index;
                    const isChecked = selected.has(i);

                    const cursor = isFocused ? kleur.cyan('❯') : ' ';
                    const checkbox = isChecked ? kleur.green('✔') : kleur.dim('○');
                    const label = isFocused ? kleur.bold(opt) : opt;
                    const shortcut = i < 9 ? kleur.dim(`(${i + 1})`) : '';

                    process.stdout.write(`\x1b[2K\r  ${cursor} ${checkbox} ${label} ${shortcut}\n`);
                });
            };

            console.log(`${kleur.bold(question)}`);
            (process.stdin as any).setRawMode(true);
            process.stdin.resume();
            render();

            const cleanupListener = onKeyPress((_str, key) => {
                if (key.name === 'up' || key.name === 'k') {
                    index = (index - 1 + options.length) % options.length;
                    render(true);
                } else if (key.name === 'down' || key.name === 'j') {
                    index = (index + 1) % options.length;
                    render(true);
                } else if (key.name === 'space') {
                    if (selected.has(index)) {
                        selected.delete(index);
                    } else {
                        selected.add(index);
                    }
                    render(true);
                } else if (key.name === 'return') {
                    cleanupListener();
                    cleanup();
                    const result = options.filter((_, i) => selected.has(i));
                    resolve(result);
                } else if (/[1-9]/.test(key.name)) {
                    const num = parseInt(key.name) - 1;
                    if (num >= 0 && num < options.length) {
                        index = num;
                        if (selected.has(index)) {
                            selected.delete(index);
                        } else {
                            selected.add(index);
                        }
                        render(true);
                    }
                }
            });
        });
    } else {
        options.forEach((opt, i) => console.log(`  [${i + 1}] ${opt}`));
        process.stdout.write(`${question} Choose comma-separated indices (e.g. 1,2): `);
        const answer = await readLineFromPipe();
        const indices = answer.split(',').map(s => parseInt(s.trim()) - 1);
        return options.filter((_, i) => indices.includes(i));
    }
}
