/**
 * Zero-dependency schema validation, replacing `zod`.
 *
 * Exposes the `z.*` surface Lunx actually uses, with the same call shapes and
 * the same `parse` / `safeParse` semantics, so call sites are unchanged:
 *
 *   z.object({ port: z.number().default(5173) }).parse(input)
 *
 * Errors carry a `issues` array of `{ path, message }`, and `ZodError.message`
 * renders them as one readable block.
 */

export interface Issue {
    path: (string | number)[];
    message: string;
    code: string;
}

export class ZodError extends Error {
    readonly issues: Issue[];

    constructor(issues: Issue[]) {
        super(ZodError.format(issues));
        this.name = 'ZodError';
        this.issues = issues;
    }

    static format(issues: Issue[]): string {
        return issues
            .map((issue) => {
                const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
                return `  ${where}: ${issue.message}`;
            })
            .join('\n');
    }

    /** zod-compatible alias. */
    get errors(): Issue[] {
        return this.issues;
    }

    flatten(): { formErrors: string[]; fieldErrors: Record<string, string[]> } {
        const formErrors: string[] = [];
        const fieldErrors: Record<string, string[]> = {};
        for (const issue of this.issues) {
            if (issue.path.length === 0) formErrors.push(issue.message);
            else (fieldErrors[String(issue.path[0])] ??= []).push(issue.message);
        }
        return { formErrors, fieldErrors };
    }
}

export type SafeParseResult<T> = { success: true; data: T } | { success: false; error: ZodError };

interface Context {
    path: (string | number)[];
    issues: Issue[];
}

const FAIL = Symbol('invalid');
type Outcome<T> = T | typeof FAIL;

export abstract class Type<T> {
    /** Present only so `z.infer<typeof schema>` resolves; never read at runtime. */
    declare readonly _output: T;

    protected abstract check(value: unknown, ctx: Context): Outcome<T>;

    /** Subclasses override to describe themselves in error messages. */
    abstract get typeName(): string;

    parse(value: unknown): T {
        const ctx: Context = { path: [], issues: [] };
        const result = this.check(value, ctx);
        if (result === FAIL || ctx.issues.length > 0) throw new ZodError(ctx.issues);
        return result;
    }

    safeParse(value: unknown): SafeParseResult<T> {
        const ctx: Context = { path: [], issues: [] };
        const result = this.check(value, ctx);
        if (result === FAIL || ctx.issues.length > 0) return { success: false, error: new ZodError(ctx.issues) };
        return { success: true, data: result };
    }

    /** Internal entry point used when nesting one schema inside another. */
    run(value: unknown, ctx: Context): Outcome<T> {
        return this.check(value, ctx);
    }

    optional(): OptionalType<T> {
        return new OptionalType(this);
    }

    nullable(): NullableType<T> {
        return new NullableType(this);
    }

    default(value: T | (() => T)): DefaultType<T> {
        return new DefaultType(this, value);
    }

    /** Falls back to `value` instead of failing. */
    catch(value: T | (() => T)): CatchType<T> {
        return new CatchType(this, value);
    }

    array(): ArrayType<T> {
        return new ArrayType(this);
    }

    transform<U>(fn: (value: T) => U): TransformType<T, U> {
        return new TransformType(this, fn);
    }

    refine(predicate: (value: T) => boolean, message = 'Invalid value'): RefineType<T> {
        return new RefineType(this, predicate, message);
    }

    describe(_description: string): this {
        return this;
    }
}

function fail(ctx: Context, message: string, code = 'invalid_type'): typeof FAIL {
    ctx.issues.push({ path: [...ctx.path], message, code });
    return FAIL;
}

function nested<T>(schema: Type<T>, value: unknown, ctx: Context, key: string | number): Outcome<T> {
    ctx.path.push(key);
    try {
        return schema.run(value, ctx);
    } finally {
        ctx.path.pop();
    }
}

// ── Primitives ──────────────────────────────────────────────────────────────

type StringRule = (value: string, ctx: Context) => boolean;

export class StringType extends Type<string> {
    private readonly rules: Array<{ run: StringRule; message: string }> = [];

    get typeName(): string {
        return 'string';
    }

    private clone(rule: StringRule, message: string): StringType {
        const next = new StringType();
        next.rules.push(...this.rules, { run: rule, message });
        return next;
    }

    min(length: number, message = `String must contain at least ${length} character(s)`): StringType {
        return this.clone((v) => v.length >= length, message);
    }

    max(length: number, message = `String must contain at most ${length} character(s)`): StringType {
        return this.clone((v) => v.length <= length, message);
    }

    length(exact: number, message = `String must be exactly ${exact} character(s)`): StringType {
        return this.clone((v) => v.length === exact, message);
    }

    nonempty(message = 'String must not be empty'): StringType {
        return this.clone((v) => v.length > 0, message);
    }

    regex(pattern: RegExp, message = `String must match ${pattern}`): StringType {
        // A `g` flag makes `test` stateful across calls; use a fresh copy each time.
        const source = pattern.source;
        const flags = pattern.flags.replace('g', '');
        return this.clone((v) => new RegExp(source, flags).test(v), message);
    }

    startsWith(prefix: string, message = `String must start with "${prefix}"`): StringType {
        return this.clone((v) => v.startsWith(prefix), message);
    }

    endsWith(suffix: string, message = `String must end with "${suffix}"`): StringType {
        return this.clone((v) => v.endsWith(suffix), message);
    }

    url(message = 'Invalid url'): StringType {
        return this.clone((v) => {
            try {
                new URL(v);
                return true;
            } catch {
                return false;
            }
        }, message);
    }

    email(message = 'Invalid email'): StringType {
        return this.clone((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), message);
    }

    uuid(message = 'Invalid uuid'): StringType {
        return this.clone(
            (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v),
            message,
        );
    }

    protected check(value: unknown, ctx: Context): Outcome<string> {
        if (typeof value !== 'string') return fail(ctx, `Expected string, received ${describe(value)}`);
        for (const rule of this.rules) {
            if (!rule.run(value, ctx)) return fail(ctx, rule.message, 'invalid_string');
        }
        return value;
    }
}

type NumberRule = { run: (value: number) => boolean; message: string };

export class NumberType extends Type<number> {
    private readonly rules: NumberRule[] = [];

    get typeName(): string {
        return 'number';
    }

    private clone(run: (value: number) => boolean, message: string): NumberType {
        const next = new NumberType();
        next.rules.push(...this.rules, { run, message });
        return next;
    }

    min(bound: number, message = `Number must be greater than or equal to ${bound}`): NumberType {
        return this.clone((v) => v >= bound, message);
    }

    max(bound: number, message = `Number must be less than or equal to ${bound}`): NumberType {
        return this.clone((v) => v <= bound, message);
    }

    gt(bound: number, message = `Number must be greater than ${bound}`): NumberType {
        return this.clone((v) => v > bound, message);
    }

    lt(bound: number, message = `Number must be less than ${bound}`): NumberType {
        return this.clone((v) => v < bound, message);
    }

    gte(bound: number, message?: string): NumberType {
        return this.min(bound, message);
    }

    lte(bound: number, message?: string): NumberType {
        return this.max(bound, message);
    }

    int(message = 'Expected integer'): NumberType {
        return this.clone((v) => Number.isInteger(v), message);
    }

    positive(message = 'Number must be greater than 0'): NumberType {
        return this.clone((v) => v > 0, message);
    }

    nonnegative(message = 'Number must be greater than or equal to 0'): NumberType {
        return this.clone((v) => v >= 0, message);
    }

    finite(message = 'Number must be finite'): NumberType {
        return this.clone((v) => Number.isFinite(v), message);
    }

    protected check(value: unknown, ctx: Context): Outcome<number> {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            return fail(ctx, `Expected number, received ${describe(value)}`);
        }
        for (const rule of this.rules) {
            if (!rule.run(value)) return fail(ctx, rule.message, 'too_small');
        }
        return value;
    }
}

export class BooleanType extends Type<boolean> {
    get typeName(): string {
        return 'boolean';
    }

    protected check(value: unknown, ctx: Context): Outcome<boolean> {
        if (typeof value !== 'boolean') return fail(ctx, `Expected boolean, received ${describe(value)}`);
        return value;
    }
}

export class AnyType extends Type<any> {
    get typeName(): string {
        return 'any';
    }

    protected check(value: unknown): Outcome<any> {
        return value;
    }
}

export class UnknownType extends Type<unknown> {
    get typeName(): string {
        return 'unknown';
    }

    protected check(value: unknown): Outcome<unknown> {
        return value;
    }
}

export class LiteralType<T extends string | number | boolean | null> extends Type<T> {
    constructor(private readonly value: T) {
        super();
    }

    get typeName(): string {
        return JSON.stringify(this.value);
    }

    protected check(value: unknown, ctx: Context): Outcome<T> {
        if (value !== this.value) {
            return fail(ctx, `Expected ${JSON.stringify(this.value)}, received ${describe(value)}`);
        }
        return value as T;
    }
}

export class EnumType<T extends readonly [string, ...string[]]> extends Type<T[number]> {
    readonly options: T;

    constructor(options: T) {
        super();
        this.options = options;
    }

    get typeName(): string {
        return this.options.join(' | ');
    }

    protected check(value: unknown, ctx: Context): Outcome<T[number]> {
        if (typeof value !== 'string' || !this.options.includes(value)) {
            return fail(ctx, `Expected one of ${this.options.map((o) => `"${o}"`).join(', ')}, received ${describe(value)}`);
        }
        return value as T[number];
    }
}

// ── Wrappers ────────────────────────────────────────────────────────────────

export class OptionalType<T> extends Type<T | undefined> {
    constructor(private readonly inner: Type<T>) {
        super();
    }

    get typeName(): string {
        return `${this.inner.typeName} | undefined`;
    }

    unwrap(): Type<T> {
        return this.inner;
    }

    protected check(value: unknown, ctx: Context): Outcome<T | undefined> {
        if (value === undefined) return undefined;
        return this.inner.run(value, ctx);
    }
}

export class NullableType<T> extends Type<T | null> {
    constructor(private readonly inner: Type<T>) {
        super();
    }

    get typeName(): string {
        return `${this.inner.typeName} | null`;
    }

    protected check(value: unknown, ctx: Context): Outcome<T | null> {
        if (value === null) return null;
        return this.inner.run(value, ctx);
    }
}

export class DefaultType<T> extends Type<T> {
    constructor(
        private readonly inner: Type<T>,
        private readonly fallback: T | (() => T),
    ) {
        super();
    }

    get typeName(): string {
        return this.inner.typeName;
    }

    protected check(value: unknown, ctx: Context): Outcome<T> {
        if (value === undefined) return resolve(this.fallback);
        return this.inner.run(value, ctx);
    }
}

export class CatchType<T> extends Type<T> {
    constructor(
        private readonly inner: Type<T>,
        private readonly fallback: T | (() => T),
    ) {
        super();
    }

    get typeName(): string {
        return this.inner.typeName;
    }

    protected check(value: unknown, ctx: Context): Outcome<T> {
        // A caught failure must not leave issues behind for the parent to report.
        const mark = ctx.issues.length;
        const result = this.inner.run(value, ctx);
        if (result === FAIL || ctx.issues.length > mark) {
            ctx.issues.length = mark;
            return resolve(this.fallback);
        }
        return result;
    }
}

export class TransformType<In, Out> extends Type<Out> {
    constructor(
        private readonly inner: Type<In>,
        private readonly fn: (value: In) => Out,
    ) {
        super();
    }

    get typeName(): string {
        return this.inner.typeName;
    }

    protected check(value: unknown, ctx: Context): Outcome<Out> {
        const result = this.inner.run(value, ctx);
        if (result === FAIL) return FAIL;
        return this.fn(result);
    }
}

export class RefineType<T> extends Type<T> {
    constructor(
        private readonly inner: Type<T>,
        private readonly predicate: (value: T) => boolean,
        private readonly message: string,
    ) {
        super();
    }

    get typeName(): string {
        return this.inner.typeName;
    }

    protected check(value: unknown, ctx: Context): Outcome<T> {
        const result = this.inner.run(value, ctx);
        if (result === FAIL) return FAIL;
        if (!this.predicate(result)) return fail(ctx, this.message, 'custom');
        return result;
    }
}

// ── Collections ─────────────────────────────────────────────────────────────

export class ArrayType<T> extends Type<T[]> {
    private minLength?: number;
    private maxLength?: number;

    constructor(private readonly element: Type<T>) {
        super();
    }

    get typeName(): string {
        return `${this.element.typeName}[]`;
    }

    min(length: number): ArrayType<T> {
        const next = new ArrayType(this.element);
        next.minLength = length;
        next.maxLength = this.maxLength;
        return next;
    }

    max(length: number): ArrayType<T> {
        const next = new ArrayType(this.element);
        next.minLength = this.minLength;
        next.maxLength = length;
        return next;
    }

    nonempty(): ArrayType<T> {
        return this.min(1);
    }

    protected check(value: unknown, ctx: Context): Outcome<T[]> {
        if (!Array.isArray(value)) return fail(ctx, `Expected array, received ${describe(value)}`);
        if (this.minLength !== undefined && value.length < this.minLength) {
            return fail(ctx, `Array must contain at least ${this.minLength} element(s)`, 'too_small');
        }
        if (this.maxLength !== undefined && value.length > this.maxLength) {
            return fail(ctx, `Array must contain at most ${this.maxLength} element(s)`, 'too_big');
        }
        const out: T[] = [];
        let ok = true;
        for (let i = 0; i < value.length; i++) {
            const item = nested(this.element, value[i], ctx, i);
            if (item === FAIL) ok = false;
            else out.push(item);
        }
        return ok ? out : FAIL;
    }
}

export class RecordType<V> extends Type<Record<string, V>> {
    constructor(
        private readonly value: Type<V>,
        /** zod v4 validates keys too; omitted means any string key. */
        private readonly key?: Type<string>,
    ) {
        super();
    }

    get typeName(): string {
        return `Record<${this.key?.typeName ?? 'string'}, ${this.value.typeName}>`;
    }

    protected check(input: unknown, ctx: Context): Outcome<Record<string, V>> {
        if (!isPlainObject(input)) return fail(ctx, `Expected object, received ${describe(input)}`);
        const out: Record<string, V> = {};
        let ok = true;
        for (const [key, raw] of Object.entries(input)) {
            if (this.key) {
                const parsedKey = nested(this.key, key, ctx, key);
                if (parsedKey === FAIL) {
                    ok = false;
                    continue;
                }
            }
            const parsed = nested(this.value, raw, ctx, key);
            if (parsed === FAIL) ok = false;
            else out[key] = parsed;
        }
        return ok ? out : FAIL;
    }
}

export type Shape = Record<string, Type<any>>;

/**
 * Fields whose schema accepts `undefined` become optional *keys*, not
 * required keys of type `T | undefined`. This mirrors zod and is what lets
 * `{ a: 'x' }` satisfy `{ a: string; b?: number }`.
 */
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends S[K]['_output'] ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Prettify<T> = { [K in keyof T]: T[K] } & {};

export type InferShape<S extends Shape> = Prettify<
    { [K in RequiredKeys<S>]: S[K]['_output'] } & { [K in OptionalKeys<S>]?: S[K]['_output'] }
>;

type UnknownKeys = 'strip' | 'passthrough' | 'strict';

export class ObjectType<S extends Shape> extends Type<InferShape<S>> {
    readonly shape: S;
    private readonly unknownKeys: UnknownKeys;

    constructor(shape: S, unknownKeys: UnknownKeys = 'strip') {
        super();
        this.shape = shape;
        this.unknownKeys = unknownKeys;
    }

    get typeName(): string {
        return 'object';
    }

    /** Keeps keys that are not in the shape. */
    passthrough(): ObjectType<S> {
        return new ObjectType(this.shape, 'passthrough');
    }

    /** Rejects keys that are not in the shape. */
    strict(): ObjectType<S> {
        return new ObjectType(this.shape, 'strict');
    }

    strip(): ObjectType<S> {
        return new ObjectType(this.shape, 'strip');
    }

    extend<E extends Shape>(extension: E): ObjectType<S & E> {
        return new ObjectType({ ...this.shape, ...extension } as S & E, this.unknownKeys);
    }

    merge<O extends Shape>(other: ObjectType<O>): ObjectType<S & O> {
        return this.extend(other.shape);
    }

    pick<K extends keyof S>(keys: K[]): ObjectType<Pick<S, K>> {
        const shape = {} as Pick<S, K>;
        for (const key of keys) shape[key] = this.shape[key]!;
        return new ObjectType(shape, this.unknownKeys);
    }

    omit<K extends keyof S>(keys: K[]): ObjectType<Omit<S, K>> {
        const shape = { ...this.shape };
        for (const key of keys) delete shape[key];
        return new ObjectType(shape as Omit<S, K>, this.unknownKeys);
    }

    partial(): ObjectType<{ [K in keyof S]: OptionalType<S[K]['_output']> }> {
        const shape = {} as any;
        for (const [key, schema] of Object.entries(this.shape)) shape[key] = schema.optional();
        return new ObjectType(shape, this.unknownKeys);
    }

    protected check(input: unknown, ctx: Context): Outcome<InferShape<S>> {
        if (!isPlainObject(input)) return fail(ctx, `Expected object, received ${describe(input)}`);

        const out: Record<string, unknown> = {};
        let ok = true;

        for (const [key, schema] of Object.entries(this.shape)) {
            const parsed = nested(schema, input[key], ctx, key);
            if (parsed === FAIL) {
                ok = false;
                continue;
            }
            // An absent optional key stays absent rather than becoming `undefined`.
            if (parsed === undefined && !(key in input)) continue;
            out[key] = parsed;
        }

        if (this.unknownKeys !== 'strip') {
            for (const key of Object.keys(input)) {
                if (key in this.shape) continue;
                if (this.unknownKeys === 'passthrough') out[key] = input[key];
                else {
                    ctx.path.push(key);
                    fail(ctx, `Unrecognized key "${key}"`, 'unrecognized_keys');
                    ctx.path.pop();
                    ok = false;
                }
            }
        }

        return ok ? (out as InferShape<S>) : FAIL;
    }
}

export class UnionType<T extends readonly Type<any>[]> extends Type<T[number]['_output']> {
    constructor(private readonly options: T) {
        super();
    }

    get typeName(): string {
        return this.options.map((o) => o.typeName).join(' | ');
    }

    protected check(value: unknown, ctx: Context): Outcome<T[number]['_output']> {
        const mark = ctx.issues.length;
        for (const option of this.options) {
            const result = option.run(value, ctx);
            if (result !== FAIL && ctx.issues.length === mark) return result;
            // Discard the failed branch's issues before trying the next one.
            ctx.issues.length = mark;
        }
        return fail(ctx, `Expected ${this.typeName}, received ${describe(value)}`, 'invalid_union');
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolve<T>(value: T | (() => T)): T {
    return typeof value === 'function' ? (value as () => T)() : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value === undefined) return 'undefined';
    if (Number.isNaN(value)) return 'nan';
    return typeof value;
}

// ── Public factory, mirroring `z` ───────────────────────────────────────────

export const z = {
    string: () => new StringType(),
    number: () => new NumberType(),
    boolean: () => new BooleanType(),
    any: () => new AnyType(),
    unknown: () => new UnknownType(),
    literal: <T extends string | number | boolean | null>(value: T) => new LiteralType(value),
    enum: <T extends readonly [string, ...string[]]>(options: T) => new EnumType(options),
    object: <S extends Shape>(shape: S) => new ObjectType(shape),
    array: <T>(element: Type<T>) => new ArrayType(element),
    /**
     * Accepts both `z.record(valueType)` (zod v3) and
     * `z.record(keyType, valueType)` (zod v4), since the codebase uses v4's form.
     */
    record: (<V>(keyOrValue: Type<any>, maybeValue?: Type<V>) =>
        maybeValue === undefined
            ? new RecordType(keyOrValue as Type<V>)
            : new RecordType(maybeValue, keyOrValue as Type<string>)) as {
        <V>(value: Type<V>): RecordType<V>;
        <V>(key: Type<string>, value: Type<V>): RecordType<V>;
    },
    union: <T extends readonly Type<any>[]>(options: T) => new UnionType(options),
    optional: <T>(inner: Type<T>) => new OptionalType(inner),
    nullable: <T>(inner: Type<T>) => new NullableType(inner),
    ZodError,
};

// Type namespace merged with the `z` value, so `z.infer<typeof X>` works as in zod.
// eslint-disable-next-line @typescript-eslint/no-namespace, no-redeclare
export namespace z {
    export type infer<T extends Type<any>> = T['_output'];
    export type ZodType<T> = Type<T>;
    export type ZodTypeAny = Type<any>;
}

export default z;
