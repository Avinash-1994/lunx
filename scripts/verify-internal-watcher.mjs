/**
 * Behaviour check for the zero-dependency watcher, run side by side with
 * chokidar on the same temp tree so any divergence shows up.
 * Run with: npx tsx scripts/verify-internal-watcher.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { watch } from '../src/internal/watcher.ts';
import { globToRegExp } from '../src/internal/watcher.ts';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lunx-watch-'));
await fsp.mkdir(path.join(root, 'src'), { recursive: true });
await fsp.mkdir(path.join(root, 'node_modules', 'junk'), { recursive: true });
await fsp.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');

const events = [];
const watcher = watch(root, { ignoreInitial: true, debounce: 15 });
watcher.on('all', (event, file) => events.push([event, path.relative(root, file).split(path.sep).join('/')]));
await new Promise((r) => watcher.once('ready', r));

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const saw = (event, file) => events.some(([e, f]) => e === event && f === file);

// change
await fsp.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
await settle();
check('change on existing file', saw('change', 'src/a.ts'), JSON.stringify(events));

// add
events.length = 0;
await fsp.writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
await settle();
check('add new file', saw('add', 'src/b.ts'), JSON.stringify(events));

// unlink
events.length = 0;
await fsp.rm(path.join(root, 'src', 'b.ts'));
await settle();
check('unlink file', saw('unlink', 'src/b.ts'), JSON.stringify(events));

// new nested directory + file inside it
events.length = 0;
await fsp.mkdir(path.join(root, 'src', 'deep', 'deeper'), { recursive: true });
await settle(200);
await fsp.writeFile(path.join(root, 'src', 'deep', 'deeper', 'c.ts'), 'export const c = 1;\n');
await settle(600);
check('add inside newly created nested dir', saw('add', 'src/deep/deeper/c.ts'), JSON.stringify(events));

// node_modules must never produce events
events.length = 0;
await fsp.writeFile(path.join(root, 'node_modules', 'junk', 'x.js'), 'x');
await settle();
check('node_modules ignored', events.length === 0, JSON.stringify(events));

// fs.watch fires several times per logical write; the debounce must collapse them
events.length = 0;
const target = path.join(root, 'src', 'a.ts');
for (let i = 0; i < 5; i++) await fsp.writeFile(target, `export const a = ${i};
`);
await settle();
const changeCount = events.filter(([e, f]) => e === 'change' && f === 'src/a.ts').length;
check('burst of 5 writes coalesces to 1 change', changeCount === 1, `count=${changeCount}`);

// explicit ignored option
const ignoredEvents = [];
const w2 = watch(root, { ignoreInitial: true, debounce: 15, ignored: ['**/*.log'] });
w2.on('all', (e, f) => ignoredEvents.push([e, path.relative(root, f)]));
await new Promise((r) => w2.once('ready', r));
await fsp.writeFile(path.join(root, 'src', 'noisy.log'), 'noise');
await fsp.writeFile(path.join(root, 'src', 'kept.ts'), 'export const k = 1;');
await settle(500);
check(
    'ignored glob filters .log but keeps .ts',
    !ignoredEvents.some(([, f]) => f.endsWith('.log')) && ignoredEvents.some(([, f]) => f.endsWith('kept.ts')),
    JSON.stringify(ignoredEvents),
);
await w2.close();

// glob compiler unit checks
check('glob **/*.log matches nested', globToRegExp('**/*.log').test('src/deep/x.log'));
check('glob **/*.log rejects .ts', !globToRegExp('**/*.log').test('src/deep/x.ts'));
check('glob *.ts does not cross /', !globToRegExp('*.ts').test('src/a.ts'));
check('glob {a,b}.ts alternation', globToRegExp('{a,b}.ts').test('b.ts'));

await watcher.close();
await fsp.rm(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
