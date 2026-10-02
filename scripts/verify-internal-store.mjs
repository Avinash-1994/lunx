/**
 * Behaviour check for the JSON-backed stores that replaced better-sqlite3,
 * including persistence across instances and crash-safety of writes.
 * Run with: npx tsx scripts/verify-internal-store.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CacheStore, RecordStore, fingerprint } from '../src/lib/store.ts';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lunx-store-'));

// ── CacheStore ──────────────────────────────────────────────────────────────
const cacheDir = path.join(root, 'cache');
const cache = new CacheStore(cacheDir);

check('cache miss returns null', cache.get('nope') === null);
check('cache has() false before set', cache.has('nope') === false);

const key = fingerprint('source code', 'file.ts');
cache.set(key, { code: 'compiled', map: 'sourcemap' });
check('cache hit after set', JSON.stringify(cache.get(key)) === JSON.stringify({ code: 'compiled', map: 'sourcemap' }));
check('cache has() true after set', cache.has(key) === true);
check('cache size is 1', cache.size === 1, `size=${cache.size}`);

// A second instance on the same directory must see the entry.
const reopened = new CacheStore(cacheDir);
check('cache persists across instances', JSON.stringify(reopened.get(key)) === JSON.stringify({ code: 'compiled', map: 'sourcemap' }));

cache.set(key, { code: 'recompiled' });
check('cache overwrite', cache.get(key).code === 'recompiled');

cache.delete(key);
check('cache delete', cache.get(key) === null && cache.size === 0);

// Sharding: many keys land in separate directories, all retrievable.
const many = Array.from({ length: 300 }, (_, i) => fingerprint('mod', i));
for (const [i, k] of many.entries()) cache.set(k, i);
check('300 entries all readable', many.every((k, i) => cache.get(k) === i));
check('300 entries counted', cache.size === 300, `size=${cache.size}`);
const shards = fs.readdirSync(cacheDir).filter((d) => fs.statSync(path.join(cacheDir, d)).isDirectory());
check('entries sharded across directories', shards.length > 1, `shards=${shards.length}`);

// A corrupt entry must read as a miss, not throw.
const victim = many[0];
const victimFile = path.join(cacheDir, victim.slice(0, 2), `${victim}.json`);
fs.writeFileSync(victimFile, '{ truncated');
check('corrupt entry reads as miss', new CacheStore(cacheDir).get(victim) === null);

// No .tmp files left behind after writes.
const strays = shards.flatMap((d) => fs.readdirSync(path.join(cacheDir, d)).filter((f) => f.includes('.tmp')));
check('no temp files left behind', strays.length === 0, strays.join(','));

// Eviction once over the ceiling.
const small = new CacheStore(path.join(root, 'small'), { maxEntries: 20 });
for (let i = 0; i < 40; i++) small.set(fingerprint('x', i), i);
check('cache prunes past maxEntries', small.size <= 40 && small.size < 40, `size=${small.size}`);

// ── RecordStore ─────────────────────────────────────────────────────────────
const file = path.join(root, 'records.json');
const store = new RecordStore(file);

check('empty store count 0', store.count() === 0);
check('get missing returns null', store.get('a') === null);

store.put({ id: 'a', name: 'alpha', hits: 3 });
store.put({ id: 'b', name: 'beta', hits: 5 });
store.put({ id: 'c', name: 'gamma', hits: 0 });
check('count after 3 puts', store.count() === 3);
check('get by id', store.get('b').name === 'beta');
check('has', store.has('a') && !store.has('zz'));
check('find by predicate', store.find((r) => r.hits > 0).length === 2);
check('findOne', store.findOne((r) => r.name === 'gamma').id === 'c');
check('count with predicate', store.count((r) => r.hits >= 3) === 2);
check('sum numeric field', store.sum('hits') === 8, String(store.sum('hits')));

store.put({ id: 'b', name: 'beta2', hits: 9 });
check('put overwrites by id', store.get('b').name === 'beta2' && store.count() === 3);

check('list sorted desc', store.list({ sortBy: 'hits', desc: true })[0].id === 'b');
check('list sorted asc', store.list({ sortBy: 'hits', desc: false })[0].id === 'c');
check('list limit', store.list({ sortBy: 'hits', limit: 2 }).length === 2);

// Persistence across instances.
const reloaded = new RecordStore(file);
check('records persist across instances', reloaded.count() === 3 && reloaded.get('b').hits === 9);

check('delete returns true', store.delete('c') === true);
check('delete twice returns false', store.delete('c') === false);
check('deleteWhere', store.deleteWhere((r) => r.hits > 5) === 1 && store.count() === 1);

// Transactions collapse writes.
const txStore = new RecordStore(path.join(root, 'tx.json'));
let writesDuringTx = 0;
txStore.transaction(() => {
    for (let i = 0; i < 50; i++) txStore.put({ id: `r${i}`, n: i });
    writesDuringTx = fs.existsSync(path.join(root, 'tx.json')) ? 1 : 0;
});
check('transaction defers the write', writesDuringTx === 0);
check('transaction flushes at the end', new RecordStore(path.join(root, 'tx.json')).count() === 50);

// In-memory mode writes nothing to disk.
const mem = new RecordStore(':memory:');
mem.put({ id: 'x', v: 1 });
check(':memory: works', mem.get('x').v === 1);
check(':memory: writes no file', !fs.existsSync(path.resolve(':memory:')));

// A corrupt records file starts empty rather than throwing.
const badFile = path.join(root, 'bad.json');
fs.writeFileSync(badFile, 'not json at all');
const recovered = new RecordStore(badFile);
check('corrupt record file recovers empty', recovered.count() === 0);
recovered.put({ id: 'fresh', ok: true });
check('corrupt record file is writable again', new RecordStore(badFile).get('fresh').ok === true);

await fsp.rm(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
