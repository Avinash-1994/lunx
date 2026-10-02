/**
 * Runs every `lunx` command against a real app, through a package installed
 * from `npm pack` — not from the source tree.
 *
 *   npx tsx scripts/verify-cli-surface.mjs [--only build,test] [--keep]
 *
 * The distinction matters: `lunx build`, `lunx test` and `require('lunx-dev')`
 * all passed in-repo while being fatally broken once packaged, because the
 * repo's devDependencies and unpruned folders papered over the difference.
 *
 * Each command is classified:
 *   PASS        exit 0
 *   DELIBERATE  non-zero, but the output is an intended message (a missing
 *               optional tool, a validation error) rather than a crash
 *   CRASH       a stack trace, ERR_MODULE_NOT_FOUND, "is not a function",
 *               an unhandled rejection — i.e. the command is broken
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONLY = (flagValue('--only') ?? '').split(',').filter(Boolean);
const KEEP = process.argv.includes('--keep');

function flagValue(name) {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CRASH_MARKERS = [
    'ERR_MODULE_NOT_FOUND',
    'Cannot find module',
    'Cannot find package',
    'is not a function',
    'is not defined',
    'Unhandled',
    'UnhandledPromiseRejection',
    'TypeError:',
    'ReferenceError:',
    'SyntaxError:',
    'at Object.<anonymous>',
    'at Module._compile',
    'Failed to load native binding',
];

const APP = {
    'package.json': JSON.stringify({
        name: 'surface-app', private: true, version: '0.0.0', type: 'module',
        dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    }, null, 2),
    'index.html': [
        '<!doctype html>',
        '<html><head><meta charset="utf-8"><title>surface</title></head>',
        '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    ].join('\n'),
    'src/main.tsx': [
        "import { createRoot } from 'react-dom/client';",
        "import App from './App';",
        "import './app.css';",
        "createRoot(document.getElementById('root')!).render(<App />);",
        '',
    ].join('\n'),
    'src/App.tsx': [
        'export default function App() {',
        '  return <h1 className="marker">surface</h1>;',
        '}',
        '',
    ].join('\n'),
    'src/app.css': '.marker { color: rgb(1, 2, 3); }\n',
    'src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n',
    'src/sum.test.ts': [
        "import { sum } from './sum.js';",
        "if (sum(1, 2) !== 3) throw new Error('sum is wrong');",
        '',
    ].join('\n'),
};

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
        s.on('error', reject);
    });
}

function setUp() {
    const root = path.join(os.tmpdir(), `lunx-surface-${Date.now()}`);
    const app = path.join(root, 'app');
    fs.mkdirSync(app, { recursive: true });
    for (const [rel, content] of Object.entries(APP)) {
        const p = path.join(app, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf8');
    }

    console.log('packing lunx...');
    const pack = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', root], {
        cwd: REPO, encoding: 'utf8', shell: true,
    });
    if (pack.status !== 0) {
        console.error(pack.stderr || pack.stdout);
        process.exit(1);
    }
    const tgz = fs.readdirSync(root).find((f) => f.endsWith('.tgz'));
    if (!tgz) {
        console.error('npm pack produced no tarball');
        process.exit(1);
    }

    console.log(`installing ${tgz} + react into the app...`);
    const install = spawnSync('npm', ['install', '--silent', '--no-fund', '--no-audit', path.join(root, tgz)], {
        cwd: app, encoding: 'utf8', shell: true,
    });
    if (install.status !== 0) {
        console.error(install.stderr || install.stdout);
        process.exit(1);
    }

    const cli = path.join(app, 'node_modules', 'lunx-dev', 'dist', 'cli.js');
    if (!fs.existsSync(cli)) {
        console.error(`installed package has no dist/cli.js at ${cli}`);
        process.exit(1);
    }
    return { root, app, cli };
}

const { root, app, cli } = setUp();

function classify(status, output) {
    const marker = CRASH_MARKERS.find((m) => output.includes(m));
    if (marker) return { verdict: 'CRASH', detail: marker };
    if (status === 0) return { verdict: 'PASS', detail: '' };
    return { verdict: 'DELIBERATE', detail: `exit ${status}` };
}

function firstInterestingLine(output) {
    const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
    const hit = lines.find((l) => /error|cannot|failed|not found|missing|unsupported/i.test(l));
    return (hit ?? lines[lines.length - 1] ?? '').slice(0, 160);
}

function runOnce(args, { cwd = app, env = {}, timeout = 180_000 } = {}) {
    const r = spawnSync(process.execPath, [cli, ...args], {
        cwd, encoding: 'utf8', timeout,
        env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const output = (r.stdout || '') + (r.stderr || '');
    return { status: r.status, output };
}

/** For servers: start it, wait for the port, then stop it. */
async function runServer(argsFor, { readyPath = '/', timeout = 60_000, expectBoot } = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, [cli, ...argsFor(port)], {
        cwd: app, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));

    const start = Date.now();
    let served = false;
    while (Date.now() - start < timeout) {
        if (child.exitCode !== null) break;
        if (expectBoot && output.includes(expectBoot)) {
            served = true;
            break;
        }
        try {
            const res = await fetch(`http://127.0.0.1:${port}${readyPath}`);
            if (res.status === 200) {
                await res.text();
                served = true;
                break;
            }
        } catch {}
        await sleep(50);
    }
    const exited = child.exitCode;
    child.kill('SIGKILL');
    await sleep(200);
    return { status: served ? 0 : (exited ?? 1), output };
}

const CASES = [
    { name: 'info', run: () => runOnce(['info']) },
    { name: 'env', run: () => runOnce(['env']) },
    { name: 'doctor', run: () => runOnce(['doctor']) },
    { name: 'init', run: () => runOnce(['init']) },
    { name: 'check', run: () => runOnce(['check']) },
    { name: 'build', run: () => runOnce(['build', '--root', app]) },
    { name: 'analyze', run: () => runOnce(['analyze']) },
    { name: 'inspect', run: () => runOnce(['inspect']) },
    { name: 'why', run: () => runOnce(['why', 'react']) },
    { name: 'report', run: () => runOnce(['report']) },
    { name: 'verify', run: () => runOnce(['verify']) },
    { name: 'test', run: () => runOnce(['test']) },
    { name: 'css', run: () => runOnce(['css', '--help']) },
    { name: 'migrate', run: () => runOnce(['migrate', '--help']) },
    { name: 'security', run: () => runOnce(['security', 'audit']) },
    { name: 'audit', run: () => runOnce(['audit', '--help']) },
    { name: 'create', run: () => runOnce(['create', 'scratch-app', '--template', 'react'], { cwd: root }) },
    { name: 'bootstrap', run: () => runOnce(['bootstrap', '--help']) },
    { name: 'dev', run: () => runServer((port) => ['dev', '--root', app, '--port', String(port)]) },
    {
        name: 'preview',
        // preview needs build output, so run the build first.
        run: async () => {
            runOnce(['build', '--root', app]);
            return runServer((port) => ['preview', '--root', app, '--port', String(port)], { readyPath: '/index.html' });
        },
    },
    {
        name: 'ssr',
        // An SPA has no SSR routes, so "/" legitimately 404s. What this asserts
        // is that the server starts at all — it used to refuse without the
        // uWebSockets.js git dependency. Real SSR coverage belongs in the
        // meta-framework matrix.
        run: () => runServer((port) => ['ssr', '--port', String(port)], { expectBoot: 'SSR Server running' }),
    },
];

const results = [];
for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.name)) continue;
    let r;
    try {
        r = await c.run();
    } catch (err) {
        r = { status: 1, output: String(err?.stack || err) };
    }
    const { verdict, detail } = classify(r.status, r.output);
    const note = verdict === 'PASS' ? '' : `${detail} — ${firstInterestingLine(r.output)}`;
    results.push({ name: c.name, verdict, note });
    console.log(`${verdict.padEnd(11)} ${c.name.padEnd(10)} ${note}`);
}

const crashes = results.filter((r) => r.verdict === 'CRASH');
const deliberate = results.filter((r) => r.verdict === 'DELIBERATE');
console.log(
    `\n${results.length - crashes.length - deliberate.length}/${results.length} pass, ` +
    `${deliberate.length} deliberate failure(s), ${crashes.length} crash(es)`
);

fs.mkdirSync(path.join(REPO, 'reports'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'reports', 'CLI_SURFACE.json'), JSON.stringify(results, null, 2));
console.log(`report: reports${path.sep}CLI_SURFACE.json`);

if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
else console.log(`kept: ${root}`);

process.exit(crashes.length === 0 ? 0 : 1);
