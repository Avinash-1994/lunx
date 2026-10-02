/**
 * Differential check: our schema validator against zod, on the shapes Lunx
 * config actually uses. Run with: npx tsx scripts/verify-internal-schema.mjs
 */
import assert from 'node:assert';
import { z as zod } from 'zod';
import { z } from '../src/internal/schema.ts';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** Runs the same input through both schemas and compares success + data. */
function compare(name, ourSchema, zodSchema, input) {
    const ours = ourSchema.safeParse(input);
    const theirs = zodSchema.safeParse(input);
    if (ours.success !== theirs.success) {
        check(name, false, `ours.success=${ours.success} zod.success=${theirs.success} ${ours.error?.message ?? ''}`);
        return;
    }
    if (!ours.success) {
        check(`${name} (both reject)`, true);
        return;
    }
    let ok = true;
    try {
        assert.deepStrictEqual(ours.data, theirs.data);
    } catch {
        ok = false;
    }
    check(name, ok, ok ? '' : `\n    ours ${JSON.stringify(ours.data)}\n    zod  ${JSON.stringify(theirs.data)}`);
}

// primitives
compare('string ok', z.string(), zod.string(), 'hi');
compare('string reject number', z.string(), zod.string(), 42);
compare('number ok', z.number(), zod.number(), 42);
compare('number reject string', z.number(), zod.number(), '42');
compare('number rejects NaN', z.number(), zod.number(), NaN);
compare('boolean ok', z.boolean(), zod.boolean(), true);
compare('any passes anything', z.any(), zod.any(), { a: 1 });
compare('literal ok', z.literal('react'), zod.literal('react'), 'react');
compare('literal reject', z.literal('react'), zod.literal('react'), 'vue');

// enum
const frameworks = ['react', 'vue', 'svelte', 'solid'];
compare('enum ok', z.enum(frameworks), zod.enum(frameworks), 'vue');
compare('enum reject', z.enum(frameworks), zod.enum(frameworks), 'angularjs');

// optional / default / catch
compare('optional absent', z.string().optional(), zod.string().optional(), undefined);
compare('optional present', z.string().optional(), zod.string().optional(), 'x');
compare('default applied', z.number().default(5173), zod.number().default(5173), undefined);
compare('default overridden', z.number().default(5173), zod.number().default(5173), 3000);
compare('catch on bad input', z.number().catch(0), zod.number().catch(0), 'nope');
compare('catch passes good input', z.number().catch(0), zod.number().catch(0), 7);
compare('nullable', z.string().nullable(), zod.string().nullable(), null);

// string refinements
compare('string min ok', z.string().min(3), zod.string().min(3), 'abcd');
compare('string min reject', z.string().min(3), zod.string().min(3), 'ab');
compare('string regex ok', z.string().regex(/^v\d+$/), zod.string().regex(/^v\d+$/), 'v2');
compare('string regex reject', z.string().regex(/^v\d+$/), zod.string().regex(/^v\d+$/), 'x2');
compare('string endsWith ok', z.string().endsWith('.js'), zod.string().endsWith('.js'), 'remoteEntry.js');
compare('string endsWith reject', z.string().endsWith('.js'), zod.string().endsWith('.js'), 'remoteEntry.mjs');
compare('string startsWith', z.string().startsWith('http'), zod.string().startsWith('http'), 'http://x');

// number refinements
compare('number int reject float', z.number().int(), zod.number().int(), 1.5);
compare('number positive reject 0', z.number().positive(), zod.number().positive(), 0);
compare('number min/max in range', z.number().min(1).max(65535), zod.number().min(1).max(65535), 3000);
compare('number min/max out of range', z.number().min(1).max(65535), zod.number().min(1).max(65535), 99999);

// arrays
compare('array of strings', z.array(z.string()), zod.array(zod.string()), ['a', 'b']);
compare('array rejects wrong element', z.array(z.string()), zod.array(zod.string()), ['a', 2]);
compare('array() chain', z.string().array(), zod.string().array(), ['a']);
compare('array empty ok', z.array(z.string()), zod.array(zod.string()), []);

// records
compare('record of strings', z.record(z.string(), z.string()), zod.record(zod.string(), zod.string()), { a: 'x', b: 'y' });
compare('record rejects bad value', z.record(z.string(), z.string()), zod.record(zod.string(), zod.string()), { a: 1 });

// unions
const strOrNum = [z.string(), z.number()];
compare('union takes string', z.union(strOrNum), zod.union([zod.string(), zod.number()]), 'x');
compare('union takes number', z.union(strOrNum), zod.union([zod.string(), zod.number()]), 1);
compare('union rejects bool', z.union(strOrNum), zod.union([zod.string(), zod.number()]), true);

// objects: strip unknown keys by default
const ourObj = z.object({ a: z.string(), b: z.number().optional() });
const zodObj = zod.object({ a: zod.string(), b: zod.number().optional() });
compare('object ok', ourObj, zodObj, { a: 'x', b: 1 });
compare('object optional omitted', ourObj, zodObj, { a: 'x' });
compare('object strips unknown keys', ourObj, zodObj, { a: 'x', extra: true });
compare('object rejects bad field', ourObj, zodObj, { a: 1 });
compare('object rejects non-object', ourObj, zodObj, 'nope');
compare('object rejects array', ourObj, zodObj, ['a']);
compare('object passthrough', ourObj.passthrough(), zodObj.passthrough(), { a: 'x', extra: true });
compare('object strict rejects extra', ourObj.strict(), zodObj.strict(), { a: 'x', extra: true });

// realistic lunx config schema
const ourConfig = z.object({
    framework: z.enum(['react', 'vue', 'svelte', 'solid', 'angular', 'vanilla']).optional(),
    entry: z.union([z.string(), z.array(z.string())]).optional(),
    outDir: z.string().default('dist'),
    server: z
        .object({
            port: z.number().int().min(1).max(65535).default(5173),
            open: z.boolean().default(false),
            proxy: z.record(z.string(), z.string()).optional(),
        })
        .optional(),
    build: z
        .object({
            minify: z.boolean().default(true),
            sourcemap: z.union([z.boolean(), z.enum(['inline', 'external'])]).default(false),
            targets: z.array(z.string()).optional(),
        })
        .optional(),
    federation: z
        .object({
            name: z.string(),
            filename: z.string().endsWith('.js').default('remoteEntry.js'),
            remotes: z.record(z.string(), z.string()).optional(),
            exposes: z.record(z.string(), z.string()).optional(),
        })
        .optional(),
});
const zodConfig = zod.object({
    framework: zod.enum(['react', 'vue', 'svelte', 'solid', 'angular', 'vanilla']).optional(),
    entry: zod.union([zod.string(), zod.array(zod.string())]).optional(),
    outDir: zod.string().default('dist'),
    server: zod
        .object({
            port: zod.number().int().min(1).max(65535).default(5173),
            open: zod.boolean().default(false),
            proxy: zod.record(zod.string(), zod.string()).optional(),
        })
        .optional(),
    build: zod
        .object({
            minify: zod.boolean().default(true),
            sourcemap: zod.union([zod.boolean(), zod.enum(['inline', 'external'])]).default(false),
            targets: zod.array(zod.string()).optional(),
        })
        .optional(),
    federation: zod
        .object({
            name: zod.string(),
            filename: zod.string().endsWith('.js').default('remoteEntry.js'),
            remotes: zod.record(zod.string(), zod.string()).optional(),
            exposes: zod.record(zod.string(), zod.string()).optional(),
        })
        .optional(),
});

compare('config: empty applies defaults', ourConfig, zodConfig, {});
compare('config: realistic', ourConfig, zodConfig, {
    framework: 'react',
    entry: ['src/main.tsx'],
    server: { port: 3000, open: true, proxy: { '/api': 'http://localhost:8080' } },
    build: { minify: true, sourcemap: 'external', targets: ['chrome90'] },
    federation: { name: 'hostApp', remotes: { navRemote: 'http://localhost:3001/remoteEntry.js' } },
});
compare('config: bad port rejected', ourConfig, zodConfig, { server: { port: 99999 } });
compare('config: bad framework rejected', ourConfig, zodConfig, { framework: 'backbone' });
compare('config: bad federation filename rejected', ourConfig, zodConfig, { federation: { name: 'a', filename: 'x.mjs' } });

// error reporting
const err = ourConfig.safeParse({ server: { port: 'x' } });
check('error has issues array', !err.success && Array.isArray(err.error.issues) && err.error.issues.length > 0);
check(
    'error path points at nested field',
    !err.success && err.error.issues[0].path.join('.') === 'server.port',
    !err.success ? err.error.issues[0].path.join('.') : '',
);

// parse throws
let threw = false;
try {
    ourConfig.parse({ framework: 'backbone' });
} catch (e) {
    threw = e.name === 'ZodError';
}
check('parse throws ZodError', threw);

// transform
compare('transform', z.string().transform((s) => s.length), zod.string().transform((s) => s.length), 'abcd');

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
