/**
 * Zero-dependency typed RPC, replacing `@trpc/server` and `@trpc/client`.
 *
 * Lunx only ever used tRPC's local `createCaller` path -- the dashboard and
 * marketplace routers are called in-process, never over HTTP -- so a build
 * tool was shipping a full RPC framework to get typed function dispatch.
 *
 * Provides the surface the call sites use:
 *
 *   const t = initTRPC.context<Ctx>().create();
 *   const router = t.router({ find: t.procedure.input(schema).query(fn) });
 *   const caller = router.createCaller(ctx);
 *
 * `toHandler()` is also provided so a router can still be served over HTTP.
 */

/** Anything with a `parse` method: our own schema module, or zod. */
export interface InputParser<T = unknown> {
    parse(value: unknown): T;
}

export type ErrorCode =
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PRECONDITION_FAILED'
    | 'TIMEOUT'
    | 'INTERNAL_SERVER_ERROR'
    | 'NOT_IMPLEMENTED';

const STATUS: Record<ErrorCode, number> = {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    PRECONDITION_FAILED: 412,
    TIMEOUT: 408,
    INTERNAL_SERVER_ERROR: 500,
    NOT_IMPLEMENTED: 501,
};

export class TRPCError extends Error {
    readonly code: ErrorCode;
    override readonly cause?: unknown;

    constructor({ code, message, cause }: { code: ErrorCode; message?: string; cause?: unknown }) {
        super(message ?? code);
        this.name = 'TRPCError';
        this.code = code;
        this.cause = cause;
    }

    get httpStatus(): number {
        return STATUS[this.code] ?? 500;
    }
}

export type ProcedureKind = 'query' | 'mutation';

export interface ResolverArgs<Input, Context> {
    input: Input;
    ctx: Context;
    type: ProcedureKind;
}

export interface Procedure<Input, Output, Context> {
    readonly _kind: ProcedureKind;
    readonly _parser: InputParser<Input> | null;
    /** Parses the input, then runs the resolver. */
    call(rawInput: unknown, ctx: Context): Promise<Output>;
    /** Present only for type inference. */
    readonly _input?: Input;
    readonly _output?: Output;
}

function isProcedure(value: unknown): value is Procedure<unknown, unknown, unknown> {
    return typeof value === 'object' && value !== null && '_kind' in value && typeof (value as any).call === 'function';
}

/** A procedure under construction: `t.procedure.input(schema).query(fn)`. */
export class ProcedureBuilder<Input, Context> {
    constructor(private readonly parser: InputParser<Input> | null = null) {}

    input<NewInput>(parser: InputParser<NewInput>): ProcedureBuilder<NewInput, Context> {
        return new ProcedureBuilder<NewInput, Context>(parser);
    }

    query<Output>(resolver: (args: ResolverArgs<Input, Context>) => Output | Promise<Output>): Procedure<Input, Awaited<Output>, Context> {
        return this.build('query', resolver);
    }

    mutation<Output>(
        resolver: (args: ResolverArgs<Input, Context>) => Output | Promise<Output>,
    ): Procedure<Input, Awaited<Output>, Context> {
        return this.build('mutation', resolver);
    }

    private build<Output>(
        kind: ProcedureKind,
        resolver: (args: ResolverArgs<Input, Context>) => Output | Promise<Output>,
    ): Procedure<Input, Awaited<Output>, Context> {
        const parser = this.parser;
        return {
            _kind: kind,
            _parser: parser,
            async call(rawInput: unknown, ctx: Context): Promise<Awaited<Output>> {
                let input: Input;
                if (parser) {
                    try {
                        input = parser.parse(rawInput);
                    } catch (cause) {
                        // A failed input schema is the caller's fault, not ours.
                        throw new TRPCError({
                            code: 'BAD_REQUEST',
                            message: cause instanceof Error ? cause.message : 'Invalid input',
                            cause,
                        });
                    }
                } else {
                    input = rawInput as Input;
                }
                return (await resolver({ input, ctx, type: kind })) as Awaited<Output>;
            },
        };
    }
}

export type RouterRecord<Context> = {
    [key: string]: Procedure<any, any, Context> | RouterRecord<Context>;
};

/** Maps the record of procedures to the caller's method signatures. */
export type Caller<T> = {
    [K in keyof T]: T[K] extends Procedure<infer I, infer O, any>
        ? undefined extends I
            ? (input?: I) => Promise<O>
            : (input: I) => Promise<O>
        : T[K] extends Record<string, unknown>
          ? Caller<T[K]>
          : never;
};

export interface Router<Routes extends RouterRecord<Context>, Context> {
    readonly _def: { record: Routes };
    createCaller(ctx: Context): Caller<Routes>;
    /** Resolves a dotted path such as `plugins.search`. */
    resolve(path: string): Procedure<any, any, Context> | null;
    /** Every procedure path, for introspection and HTTP routing. */
    paths(): string[];
    /** A node:http handler that serves the router over JSON. */
    toHandler(createContext: () => Context): (req: any, res: any) => void;
}

function buildCaller<Routes extends RouterRecord<Context>, Context>(record: Routes, ctx: Context): Caller<Routes> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
        out[key] = isProcedure(value)
            ? (input?: unknown) => value.call(input, ctx)
            : buildCaller(value as RouterRecord<Context>, ctx);
    }
    return out as Caller<Routes>;
}

function collectPaths<Context>(record: RouterRecord<Context>, prefix = ''): string[] {
    return Object.entries(record).flatMap(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return isProcedure(value) ? [path] : collectPaths(value as RouterRecord<Context>, path);
    });
}

function readBody(req: any): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk: Buffer) => {
            data += chunk;
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

class RouterImpl<Routes extends RouterRecord<Context>, Context> implements Router<Routes, Context> {
    readonly _def: { record: Routes };

    constructor(record: Routes) {
        this._def = { record };
    }

    createCaller(ctx: Context): Caller<Routes> {
        return buildCaller(this._def.record, ctx);
    }

    resolve(path: string): Procedure<any, any, Context> | null {
        let node: unknown = this._def.record;
        for (const segment of path.split('.')) {
            if (typeof node !== 'object' || node === null) return null;
            node = (node as Record<string, unknown>)[segment];
        }
        return isProcedure(node) ? (node as Procedure<any, any, Context>) : null;
    }

    paths(): string[] {
        return collectPaths(this._def.record);
    }

    toHandler(createContext: () => Context) {
        return async (req: any, res: any): Promise<void> => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const path = url.pathname.replace(/^\/+/, '');
            const procedure = this.resolve(path);

            const send = (status: number, payload: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(payload));
            };

            if (!procedure) {
                send(404, { error: { code: 'NOT_FOUND', message: `No procedure at "${path}"` } });
                return;
            }

            try {
                // Queries take input from ?input=<json>, mutations from the body.
                const raw =
                    procedure._kind === 'query'
                        ? url.searchParams.get('input')
                        : (await readBody(req)) || null;
                const input = raw ? JSON.parse(raw) : undefined;
                const result = await procedure.call(input, createContext());
                send(200, { result: { data: result } });
            } catch (error) {
                const trpcError =
                    error instanceof TRPCError
                        ? error
                        : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (error as Error).message, cause: error });
                send(trpcError.httpStatus, { error: { code: trpcError.code, message: trpcError.message } });
            }
        };
    }
}

/** Builder returned by `initTRPC.create()` / `initTRPC.context<Ctx>().create()`. */
export interface TRPCBuilder<Context> {
    procedure: ProcedureBuilder<undefined, Context>;
    router<Routes extends RouterRecord<Context>>(record: Routes): Router<Routes, Context> & Routes;
    middleware<T>(fn: T): T;
}

function createBuilder<Context>(): TRPCBuilder<Context> {
    return {
        procedure: new ProcedureBuilder<undefined, Context>(),
        router<Routes extends RouterRecord<Context>>(record: Routes) {
            const router = new RouterImpl<Routes, Context>(record);
            // Spread the record onto the router so `router.search` still resolves,
            // as it does in tRPC.
            return Object.assign(router, record) as Router<Routes, Context> & Routes;
        },
        middleware: (fn) => fn,
    };
}

export const initTRPC = {
    create<Context = object>(): TRPCBuilder<Context> {
        return createBuilder<Context>();
    },
    context<Context>() {
        return {
            create(): TRPCBuilder<Context> {
                return createBuilder<Context>();
            },
        };
    },
};

/** Type helpers mirroring `@trpc/server`. */
export type inferRouterInputs<R> = R extends Router<infer Routes, any>
    ? { [K in keyof Routes]: Routes[K] extends Procedure<infer I, any, any> ? I : never }
    : never;
export type inferRouterOutputs<R> = R extends Router<infer Routes, any>
    ? { [K in keyof Routes]: Routes[K] extends Procedure<any, infer O, any> ? O : never }
    : never;

export default { initTRPC, TRPCError };
