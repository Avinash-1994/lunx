/** Vite's Logger interface, printed with lunx's prefix. */

export type LogLevel = 'info' | 'warn' | 'error' | 'silent';

export interface Logger {
    info(msg: string, options?: { timestamp?: boolean; clear?: boolean }): void;
    warn(msg: string, options?: { timestamp?: boolean; clear?: boolean }): void;
    warnOnce(msg: string, options?: { timestamp?: boolean; clear?: boolean }): void;
    error(msg: string, options?: { timestamp?: boolean; clear?: boolean; error?: Error | null }): void;
    clearScreen(type: LogLevel): void;
    hasErrorLogged(error: Error): boolean;
    hasWarned: boolean;
}

const ranks: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3 };

export function createLogger(level: LogLevel = 'info', options: { prefix?: string; customLogger?: Logger; allowClearScreen?: boolean } = {}): Logger {
    if (options.customLogger) return options.customLogger;
    const loggedErrors = new WeakSet<Error>();
    const warned = new Set<string>();
    const threshold = ranks[level];
    const prefix = options.prefix ?? '[lunx]';
    const output = (type: 'info' | 'warn' | 'error', msg: string, opts: { timestamp?: boolean; error?: Error | null } = {}) => {
        if (ranks[type] > threshold) return;
        if (opts.error) loggedErrors.add(opts.error);
        const line = opts.timestamp ? `${new Date().toLocaleTimeString()} ${prefix} ${msg}` : msg;
        (type === 'info' ? console.log : type === 'warn' ? console.warn : console.error)(line);
    };
    const logger: Logger = {
        hasWarned: false,
        info: (msg, opts) => output('info', msg, opts),
        warn: (msg, opts) => {
            logger.hasWarned = true;
            output('warn', msg, opts);
        },
        warnOnce: (msg, opts) => {
            if (warned.has(msg)) return;
            warned.add(msg);
            logger.warn(msg, opts);
        },
        error: (msg, opts) => {
            logger.hasWarned = true;
            output('error', msg, opts);
        },
        clearScreen: () => {},
        hasErrorLogged: (error) => loggedErrors.has(error),
    };
    return logger;
}
