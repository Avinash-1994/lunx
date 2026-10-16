/** Colour codes in compiler messages (Rolldown's code frames carry them). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Whether output should be plain: `NO_COLOR` (https://no-color.org), or stderr is not a terminal. */
export const plainOutput = (): boolean => !!process.env.NO_COLOR || process.env.FORCE_COLOR === '0' || !process.stderr.isTTY;

/** `text` without colour codes when output should be plain. */
export function forTerminal(text: string): string {
    return plainOutput() ? text.replace(ANSI, '') : text;
}
