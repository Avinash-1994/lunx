/**
 * Zero-dependency terminal colours.
 *
 * Drop-in replacement for `kleur` (and the subset of `chalk` we used):
 * supports both the direct form `$.red('x')` and the chained form
 * `$.bold().red('x')` / `$.red().bold('x')`.
 */

const ESC = '[';

type Pair = readonly [open: string, close: string];

const CODES = {
    // modifiers
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    // foreground
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    blue: [34, 39],
    magenta: [35, 39],
    cyan: [36, 39],
    white: [37, 39],
    gray: [90, 39],
    grey: [90, 39],
    // background
    bgBlack: [40, 49],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgYellow: [43, 49],
    bgBlue: [44, 49],
    bgMagenta: [45, 49],
    bgCyan: [46, 49],
    bgWhite: [47, 49],
} as const satisfies Record<string, readonly [number, number]>;

export type StyleName = keyof typeof CODES;

const STYLE_NAMES = Object.keys(CODES) as StyleName[];

const PAIRS = Object.fromEntries(
    STYLE_NAMES.map((name) => {
        const [open, close] = CODES[name];
        return [name, [`${ESC}${open}m`, `${ESC}${close}m`] as Pair];
    }),
) as Record<StyleName, Pair>;

function detectColorSupport(): boolean {
    const env = process.env;
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
    if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false';
    if (env.TERM === 'dumb') return false;
    if (env.CI) return true;
    return Boolean(process.stdout && process.stdout.isTTY);
}

/**
 * A callable style that is also chainable.
 * Called with no argument it returns the chain (`$.bgRed().bold().white('x')`);
 * called with a value it returns the styled string (`$.red('x')`).
 * Property access chains too, so `$.red.bold('x')` works.
 */
export interface Style extends Chain {
    (): Chain;
    (input: unknown): string;
}

type Chain = { [K in StyleName]: Style };

/**
 * Close sequences are re-opened after any nested reset so that
 * red(`a ${bold('b')} c`) keeps the outer colour on the trailing text --
 * the same nesting fix kleur and chalk apply.
 */
function paint(text: string, active: readonly StyleName[]): string {
    if (!text) return text;
    let out = text;
    for (let i = active.length - 1; i >= 0; i--) {
        const [open, close] = PAIRS[active[i]!];
        out = open + (out.includes(close) ? out.split(close).join(close + open) : out) + close;
    }
    return out;
}

/**
 * Attaches one lazy getter per style to `target`. The getters must stay lazy:
 * eagerly materialising the chain would recurse forever.
 */
function defineChain<T extends object>(target: T, active: readonly StyleName[]): T & Chain {
    for (const name of STYLE_NAMES) {
        Object.defineProperty(target, name, {
            enumerable: true,
            configurable: true,
            get(): Style {
                const next = [...active, name];
                const style = ((input?: unknown) => {
                    // No argument -> keep chaining: $.bold().red('x')
                    if (input === undefined) return build(next);
                    const text = String(input);
                    return colors.enabled ? paint(text, next) : text;
                }) as Style;
                // Allow $.red.bold('x') as well as $.red().bold('x')
                defineChain(style, next);
                // Memoise so repeated access does not rebuild the chain.
                Object.defineProperty(this, name, { value: style, enumerable: true, configurable: true });
                return style;
            },
        });
    }
    return target as T & Chain;
}

function build(active: readonly StyleName[]): Chain {
    return defineChain({}, active);
}

export interface Colors extends Chain {
    enabled: boolean;
    /** Strip every ANSI escape sequence from a string. */
    strip(input: string): string;
    /** Visible width of a string, ignoring ANSI escapes. */
    width(input: string): number;
}

const ANSI_PATTERN = new RegExp(`${ESC.replace('[', '\\[')}[0-9;]*m`, 'g');

const colors = build([]) as Colors;
colors.enabled = detectColorSupport();
colors.strip = (input: string) => input.replace(ANSI_PATTERN, '');
colors.width = (input: string) => colors.strip(input).length;

/**
 * Named exports matching `kleur/colors`, for call sites that imported the
 * standalone functions rather than the chainable default.
 */
export const reset = (s: unknown) => colors.reset(s);
export const bold = (s: unknown) => colors.bold(s);
export const dim = (s: unknown) => colors.dim(s);
export const italic = (s: unknown) => colors.italic(s);
export const underline = (s: unknown) => colors.underline(s);
export const inverse = (s: unknown) => colors.inverse(s);
export const hidden = (s: unknown) => colors.hidden(s);
export const strikethrough = (s: unknown) => colors.strikethrough(s);
export const black = (s: unknown) => colors.black(s);
export const red = (s: unknown) => colors.red(s);
export const green = (s: unknown) => colors.green(s);
export const yellow = (s: unknown) => colors.yellow(s);
export const blue = (s: unknown) => colors.blue(s);
export const magenta = (s: unknown) => colors.magenta(s);
export const cyan = (s: unknown) => colors.cyan(s);
export const white = (s: unknown) => colors.white(s);
export const gray = (s: unknown) => colors.gray(s);
export const grey = (s: unknown) => colors.grey(s);
export const bgBlack = (s: unknown) => colors.bgBlack(s);
export const bgRed = (s: unknown) => colors.bgRed(s);
export const bgGreen = (s: unknown) => colors.bgGreen(s);
export const bgYellow = (s: unknown) => colors.bgYellow(s);
export const bgBlue = (s: unknown) => colors.bgBlue(s);
export const bgMagenta = (s: unknown) => colors.bgMagenta(s);
export const bgCyan = (s: unknown) => colors.bgCyan(s);
export const bgWhite = (s: unknown) => colors.bgWhite(s);

export default colors;
export { colors };
