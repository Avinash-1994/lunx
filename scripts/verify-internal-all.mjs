/**
 * Runs every zero-dependency replacement module's test suite.
 * Run: npx tsx scripts/verify-internal-all.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = ['ws', 'watcher', 'parsers', 'schema', 'store', 'cli', 'rpc', 'tls-proxy', 'astwalk'];

let failed = 0;
for (const suite of suites) {
    const script = path.join(here, `verify-internal-${suite}.mjs`);
    const run = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8' });
    const summary = (run.stdout || '').trim().split('\n').pop() ?? '';
    const ok = run.status === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite.padEnd(10)} ${summary}`);
    if (!ok) console.log((run.stderr || run.stdout || '').trim().split('\n').slice(-4).join('\n'));
}

console.log(`\n${suites.length - failed}/${suites.length} suites passed`);
process.exit(failed === 0 ? 0 : 1);
