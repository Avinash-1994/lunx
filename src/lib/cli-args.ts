/**
 * Zero-dependency command-line parser, replacing `yargs`.
 *
 * Implements the builder surface the Lunx CLI uses -- nested `.command()`,
 * `.option()`, `.positional()`, `.demandCommand()`, `.strict()`, `.help()`,
 * `.version()`, `.alias()`, `.fail()` -- with yargs' argument conventions:
 *
 *   --flag              boolean true
 *   --no-flag           boolean false
 *   --key value         --key=value
 *   -abc                grouped short booleans
 *   --                  everything after is passed through verbatim
 *
 * Keys are exposed in the original, camelCase and kebab-case forms, as yargs
 * does, so `--include-dist` reads as `argv.includeDist` or `argv['include-dist']`.
 */

import colors from './colors.js';

export type OptionType = 'string' | 'number' | 'boolean' | 'array' | 'count';

export interface OptionDef {
    type?: OptionType;
    alias?: string | string[];
    description?: string;
    describe?: string;
    desc?: string;
    default?: unknown;
    choices?: readonly (string | number)[];
    demandOption?: boolean | string;
    required?: boolean;
    hidden?: boolean;
}

export interface PositionalDef extends OptionDef {
    /** Positionals are matched in declaration order. */
    normalize?: boolean;
}

export interface Argv {
    _: (string | number)[];
    $0: string;
    '--'?: string[];
    [key: string]: unknown;
}

export type Builder = (parser: Parser) => Parser | void;
export type Handler = (args: Argv) => void | Promise<void>;
export type FailHandler = (message: string, error: Error | undefined, parser: Parser) => void;

interface CommandDef {
    name: string;
    /** Extra names that select this command. */
    aliases: string[];
    description: string;
    builder?: Builder;
    handler?: Handler;
    /** Positional placeholders declared in the command string, e.g. `why <module>`. */
    placeholders: { name: string; required: boolean; variadic: boolean }[];
}

function toCamelCase(key: string): string {
    return key.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function toKebabCase(key: string): string {
    return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Writes a value under every spelling yargs would expose. */
function assign(target: Argv, key: string, value: unknown, aliases: readonly string[] = []): void {
    target[key] = value;
    const camel = toCamelCase(key);
    const kebab = toKebabCase(key);
    if (camel !== key) target[camel] = value;
    if (kebab !== key) target[kebab] = value;
    // yargs exposes an option under its aliases too, so `-o` and `--open` agree.
    for (const alias of aliases) if (alias !== key) target[alias] = value;
}

export class CliError extends Error {}

export class Parser {
    private readonly optionDefs = new Map<string, OptionDef>();
    private readonly positionals: { name: string; def: PositionalDef }[] = [];
    private readonly commands: CommandDef[] = [];
    /** alias -> canonical option name */
    private readonly aliases = new Map<string, string>();
    private commandRequired: { min: number; message: string } | null = null;
    private strictMode = false;
    private helpEnabled = false;
    private versionString: string | null = null;
    private failHandler: FailHandler | null = null;
    private usageString: string | null = null;
    private epilogueString: string | null = null;

    constructor(
        private readonly rawArgs: string[],
        /** Command path leading here, used for help text and error messages. */
        private readonly commandPath: string[] = [],
        private readonly scriptName = 'lunx',
    ) {}

    // ── Builder API ────────────────────────────────────────────────────────

    option(name: string, def: OptionDef = {}): this {
        this.optionDefs.set(name, def);
        const aliasList = def.alias === undefined ? [] : Array.isArray(def.alias) ? def.alias : [def.alias];
        for (const alias of aliasList) this.aliases.set(alias, name);
        return this;
    }

    options(defs: Record<string, OptionDef>): this {
        for (const [name, def] of Object.entries(defs)) this.option(name, def);
        return this;
    }

    positional(name: string, def: PositionalDef = {}): this {
        this.positionals.push({ name, def });
        return this;
    }

    command(name: string, description: string, builder?: Builder, handler?: Handler): this {
        // `why <module> [extra..]` -> name `why` plus its placeholders.
        const parts = name.trim().split(/\s+/);
        const head = parts[0] ?? name;
        const [primary, ...aliases] = head.split('|');
        const placeholders = parts.slice(1).map((token) => {
            const required = token.startsWith('<');
            const inner = token.slice(1, -1);
            const variadic = inner.endsWith('..');
            return { name: variadic ? inner.slice(0, -2) : inner, required, variadic };
        });
        this.commands.push({
            name: primary!,
            aliases,
            description,
            builder,
            handler,
            placeholders,
        });
        return this;
    }

    demandCommand(min = 1, message = 'You must specify a command'): this {
        this.commandRequired = { min, message };
        return this;
    }

    strict(enabled = true): this {
        this.strictMode = enabled;
        return this;
    }

    /** Accepted for yargs parity; `strict()` already covers commands. */
    strictCommands(enabled = true): this {
        return this.strict(enabled);
    }

    help(): this {
        this.helpEnabled = true;
        return this;
    }

    version(value: string): this {
        this.versionString = value;
        return this;
    }

    alias(from: string, to: string): this {
        this.aliases.set(to, from);
        this.aliases.set(from, from);
        return this;
    }

    usage(text: string): this {
        this.usageString = text;
        return this;
    }

    epilogue(text: string): this {
        this.epilogueString = text;
        return this;
    }

    fail(handler: FailHandler): this {
        this.failHandler = handler;
        return this;
    }

    // ── Help ───────────────────────────────────────────────────────────────

    showHelp(write: (text: string) => void = (t) => console.log(t)): this {
        write(this.renderHelp());
        return this;
    }

    renderHelp(): string {
        const lines: string[] = [];
        const invocation = [this.scriptName, ...this.commandPath].join(' ');

        if (this.usageString) {
            lines.push(this.usageString, '');
        } else {
            const shape = this.commands.length > 0 ? '<command> [options]' : '[options]';
            lines.push(`${colors.bold('Usage:')} ${invocation} ${shape}`, '');
        }

        if (this.commands.length > 0) {
            lines.push(colors.bold('Commands:'));
            const width = Math.max(...this.commands.map((c) => c.name.length));
            for (const command of this.commands) {
                const placeholders = command.placeholders
                    .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
                    .join(' ');
                const label = `${command.name}${placeholders ? ` ${placeholders}` : ''}`;
                lines.push(`  ${colors.cyan(label.padEnd(width + 12))} ${command.description}`);
            }
            lines.push('');
        }

        const visible = [...this.optionDefs.entries()].filter(([, def]) => !def.hidden);
        if (visible.length > 0) {
            lines.push(colors.bold('Options:'));
            const rendered = visible.map(([name, def]) => {
                const aliasList = def.alias === undefined ? [] : Array.isArray(def.alias) ? def.alias : [def.alias];
                const flags = [...aliasList.map((a) => `-${a}`), `--${toKebabCase(name)}`].join(', ');
                return [flags, def] as const;
            });
            const width = Math.max(...rendered.map(([flags]) => flags.length));
            for (const [flags, def] of rendered) {
                const bits: string[] = [def.description ?? def.describe ?? def.desc ?? ''];
                if (def.choices) bits.push(colors.dim(`(${def.choices.join(' | ')})`));
                if (def.default !== undefined) bits.push(colors.dim(`[default: ${JSON.stringify(def.default)}]`));
                lines.push(`  ${colors.green(flags.padEnd(width))}  ${bits.filter(Boolean).join(' ')}`);
            }
            lines.push('');
        }

        if (this.helpEnabled || this.versionString) {
            lines.push(colors.bold('Global:'));
            if (this.helpEnabled) lines.push(`  ${colors.green('-h, --help'.padEnd(20))}  Show help`);
            if (this.versionString) lines.push(`  ${colors.green('-v, --version'.padEnd(20))}  Show version number`);
            lines.push('');
        }

        if (this.epilogueString) lines.push(this.epilogueString, '');

        return lines.join('\n').trimEnd();
    }

    /** Command names plus aliases, for "did you mean?" suggestions. */
    get commandNames(): string[] {
        return this.commands.flatMap((c) => [c.name, ...c.aliases]);
    }

    // ── Parsing ────────────────────────────────────────────────────────────

    /** Runs the matching command handler. Resolves to the parsed argv. */
    async parse(args: string[] = this.rawArgs): Promise<Argv> {
        try {
            return await this.run(args);
        } catch (error) {
            const message = error instanceof CliError ? error.message : (error as Error).message;
            if (this.failHandler) {
                this.failHandler(message, error instanceof CliError ? undefined : (error as Error), this);
                // A fail handler is expected to exit; if it returns, do not pretend we parsed.
                return { _: [], $0: this.scriptName };
            }
            console.error(`\n${colors.red(message)}\n`);
            this.showHelp((t) => console.error(t));
            process.exit(1);
        }
    }

    /** yargs compatibility: `.argv` triggers the parse. */
    get argv(): Promise<Argv> {
        return this.parse();
    }

    private async run(args: string[]): Promise<Argv> {
        const first = args.find((a) => !a.startsWith('-'));

        if (first !== undefined) {
            const command = this.commands.find((c) => c.name === first || c.aliases.includes(first));
            if (command) {
                const rest = args.slice(args.indexOf(first) + 1);
                const sub = new Parser(rest, [...this.commandPath, command.name], this.scriptName);
                sub.helpEnabled = this.helpEnabled;
                sub.failHandler = this.failHandler;
                sub.strictMode = this.strictMode;
                for (const [name, def] of this.optionDefs) sub.option(name, def);
                for (const placeholder of command.placeholders) {
                    sub.positional(placeholder.name, { demandOption: placeholder.required });
                }
                command.builder?.(sub);

                // A command whose builder only registered subcommands delegates to them.
                if (sub.commands.length > 0 && !command.handler) return sub.run(rest);
                if (sub.commands.length > 0 && rest.some((a) => !a.startsWith('-'))) {
                    const nested = rest.find((a) => !a.startsWith('-'))!;
                    if (sub.commands.some((c) => c.name === nested || c.aliases.includes(nested))) {
                        return sub.run(rest);
                    }
                }

                const parsed = sub.tokenize(rest);
                parsed.$0 = this.scriptName;
                parsed._ = [command.name, ...parsed._];

                if (this.helpEnabled && (parsed.help === true || parsed.h === true)) {
                    sub.showHelp();
                    process.exit(0);
                }
                sub.validate(parsed);
                await command.handler?.(parsed);
                return parsed;
            }
        }

        const parsed = this.tokenize(args);
        parsed.$0 = this.scriptName;

        if (this.versionString && (parsed.version === true || parsed.v === true)) {
            console.log(this.versionString);
            process.exit(0);
        }
        if (this.helpEnabled && (parsed.help === true || parsed.h === true)) {
            this.showHelp();
            process.exit(0);
        }

        if (this.commandRequired && parsed._.length < this.commandRequired.min) {
            if (this.helpEnabled && args.length === 0) {
                this.showHelp();
                process.exit(0);
            }
            throw new CliError(this.commandRequired.message);
        }
        if (this.strictMode && parsed._.length > 0 && this.commands.length > 0) {
            throw new CliError(`Unknown argument: ${parsed._[0]}`);
        }

        this.validate(parsed);
        return parsed;
    }

    /** Every alias declared for an option, for mirroring values onto them. */
    private aliasesOf(name: string | null): string[] {
        if (!name) return [];
        const def = this.optionDefs.get(name);
        if (!def || def.alias === undefined) return [];
        return Array.isArray(def.alias) ? def.alias : [def.alias];
    }

    /** Writes a parsed value under the canonical name and all of its aliases. */
    private set(target: Argv, name: string | null, key: string, value: unknown): void {
        const resolved = name ?? key;
        assign(target, resolved, value, this.aliasesOf(name));
    }

    /** Resolves an alias or kebab spelling to the declared option name. */
    private canonical(key: string): string | null {
        if (this.optionDefs.has(key)) return key;
        const viaAlias = this.aliases.get(key);
        if (viaAlias && this.optionDefs.has(viaAlias)) return viaAlias;
        const camel = toCamelCase(key);
        if (this.optionDefs.has(camel)) return camel;
        const kebab = toKebabCase(key);
        if (this.optionDefs.has(kebab)) return kebab;
        return null;
    }

    private coerce(name: string | null, raw: string): unknown {
        const type = name ? this.optionDefs.get(name)?.type : undefined;
        if (type === 'number') {
            const n = Number(raw);
            if (Number.isNaN(n)) throw new CliError(`Option --${name} expects a number, got "${raw}"`);
            return n;
        }
        if (type === 'boolean') return raw !== 'false' && raw !== '0';
        return raw;
    }

    /** Does this option consume the next token as its value? */
    private takesValue(name: string | null): boolean {
        if (!name) return false;
        const type = this.optionDefs.get(name)?.type;
        return type !== 'boolean' && type !== 'count';
    }

    private tokenize(args: string[]): Argv {
        const out: Argv = { _: [], $0: this.scriptName };
        const passthrough: string[] = [];
        let positionalIndex = 0;
        let sawSeparator = false;

        for (let i = 0; i < args.length; i++) {
            const token = args[i]!;

            if (sawSeparator) {
                passthrough.push(token);
                continue;
            }
            if (token === '--') {
                sawSeparator = true;
                continue;
            }

            if (token.startsWith('--')) {
                const body = token.slice(2);
                const eq = body.indexOf('=');

                if (eq !== -1) {
                    const key = body.slice(0, eq);
                    const name = this.canonical(key);
                    this.rejectUnknown(key, name);
                    this.set(out, name, key, this.coerce(name, body.slice(eq + 1)));
                    continue;
                }
                if (body.startsWith('no-')) {
                    const key = body.slice(3);
                    const name = this.canonical(key);
                    this.set(out, name, key, false);
                    continue;
                }

                const name = this.canonical(body);
                this.rejectUnknown(body, name);
                const next = args[i + 1];
                if (this.takesValue(name) && next !== undefined && !next.startsWith('-')) {
                    this.set(out, name, body, this.coerce(name, next));
                    i++;
                } else if (name && this.optionDefs.get(name)?.type === 'count') {
                    this.set(out, name, name, ((out[name] as number) ?? 0) + 1);
                } else if (name === null && next !== undefined && !next.startsWith('-')) {
                    // Unknown in non-strict mode: keep the value rather than dropping it.
                    this.set(out, null, body, next);
                    i++;
                } else {
                    this.set(out, name, body, true);
                }
                continue;
            }

            if (token.startsWith('-') && token.length > 1) {
                const body = token.slice(1);
                const eq = body.indexOf('=');
                if (eq !== -1) {
                    const key = body.slice(0, eq);
                    const name = this.canonical(key);
                    this.set(out, name, key, this.coerce(name, body.slice(eq + 1)));
                    continue;
                }
                // `-abc` is three short booleans unless the last one takes a value.
                for (let c = 0; c < body.length; c++) {
                    const flag = body[c]!;
                    const name = this.canonical(flag);
                    const isLast = c === body.length - 1;
                    const next = args[i + 1];
                    if (isLast && this.takesValue(name) && next !== undefined && !next.startsWith('-')) {
                        this.set(out, name, flag, this.coerce(name, next));
                        i++;
                    } else {
                        this.set(out, name, flag, true);
                    }
                }
                continue;
            }

            // Bare token: fills the next declared positional, else lands in `_`.
            const slot = this.positionals[positionalIndex];
            if (slot) {
                this.set(out, this.canonical(slot.name), slot.name, this.coerce(null, token));
                positionalIndex++;
            }
            out._.push(token);
        }

        // yargs keeps passthrough tokens in `_` and also exposes them under '--'.
        if (sawSeparator) {
            out['--'] = passthrough;
            out._.push(...passthrough);
        }

        // Defaults last, so an explicit flag always wins.
        for (const [name, def] of this.optionDefs) {
            if (def.default !== undefined && out[name] === undefined) this.set(out, name, name, def.default);
        }
        for (const { name, def } of this.positionals) {
            if (def.default !== undefined && out[name] === undefined) this.set(out, this.canonical(name), name, def.default);
        }

        return out;
    }

    private rejectUnknown(key: string, resolved: string | null): void {
        if (resolved !== null) return;
        if (!this.strictMode) return;
        // These are always accepted, even in strict mode.
        if (['help', 'h', 'version', 'v'].includes(key)) return;
        throw new CliError(`Unknown argument: --${key}`);
    }

    private validate(parsed: Argv): void {
        for (const [name, def] of this.optionDefs) {
            const value = parsed[name];
            if (value === undefined) {
                if (def.demandOption || def.required) {
                    const message = typeof def.demandOption === 'string' ? def.demandOption : `Missing required option: --${name}`;
                    throw new CliError(message);
                }
                continue;
            }
            if (def.choices && !def.choices.includes(value as string | number)) {
                throw new CliError(
                    `Invalid value for --${name}: "${String(value)}". Choose one of: ${def.choices.join(', ')}`,
                );
            }
        }
        for (const { name, def } of this.positionals) {
            if (parsed[name] === undefined && def.demandOption) {
                throw new CliError(`Missing required argument: <${name}>`);
            }
        }
    }
}

/** Drops the node binary and script path, like `yargs/helpers`' hideBin. */
export function hideBin(argv: string[]): string[] {
    return argv.slice(2);
}

/** yargs-compatible entry point. */
export default function cli(args: string[] = hideBin(process.argv), scriptName = 'lunx'): Parser {
    return new Parser(args, [], scriptName);
}

export { cli };
