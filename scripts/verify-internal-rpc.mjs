import { initTRPC, TRPCError } from '../src/lib/rpc.ts';
import { z } from '../src/lib/schema.ts';

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };

const t = initTRPC.context().create();
const router = t.router({
  ping: t.procedure.query(() => 'pong'),
  echo: t.procedure.input(z.string()).query(({ input }) => `echo:${input}`),
  add: t.procedure.input(z.object({ a: z.number(), b: z.number() })).mutation(({ input }) => input.a + input.b),
  ctx: t.procedure.query(({ ctx }) => ctx.user),
  boom: t.procedure.query(() => { throw new TRPCError({ code: 'NOT_FOUND', message: 'gone' }); }),
  nested: { deep: t.procedure.query(() => 'deep-value') },
});

const caller = router.createCaller({ user: 'avinash' });
check('query without input', await caller.ping() === 'pong');
check('query with input', await caller.echo('hi') === 'echo:hi');
check('mutation with object input', await caller.add({ a: 2, b: 3 }) === 5);
check('context is threaded through', await caller.ctx() === 'avinash');
check('nested router', await caller.nested.deep() === 'deep-value');

let code = null;
try { await caller.boom(); } catch (e) { code = e.code; }
check('TRPCError propagates its code', code === 'NOT_FOUND', String(code));

let badCode = null, badMsg = '';
try { await caller.add({ a: 'x', b: 3 }); } catch (e) { badCode = e.code; badMsg = e.message; }
check('bad input -> BAD_REQUEST', badCode === 'BAD_REQUEST', `${badCode} ${badMsg.split('\n')[0]}`);

check('paths() lists procedures', JSON.stringify(router.paths().sort()) === JSON.stringify(['add','boom','ctx','echo','nested.deep','ping']), router.paths().sort().join(','));
check('resolve() finds a nested path', router.resolve('nested.deep') !== null);
check('resolve() returns null for a miss', router.resolve('nope.nope') === null);

// HTTP handler
const http = await import('node:http');
const server = http.createServer(router.toHandler(() => ({ user: 'http-user' })));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const q = await (await fetch(`http://127.0.0.1:${port}/echo?input=${encodeURIComponent(JSON.stringify('web'))}`)).json();
check('HTTP query', q.result?.data === 'echo:web', JSON.stringify(q));
const m = await (await fetch(`http://127.0.0.1:${port}/add`, { method: 'POST', body: JSON.stringify({ a: 4, b: 6 }) })).json();
check('HTTP mutation', m.result?.data === 10, JSON.stringify(m));
const nf = await fetch(`http://127.0.0.1:${port}/missing`);
check('HTTP 404 for unknown path', nf.status === 404, String(nf.status));
const err = await fetch(`http://127.0.0.1:${port}/boom`);
check('HTTP maps TRPCError to status', err.status === 404, String(err.status));
server.close();

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
