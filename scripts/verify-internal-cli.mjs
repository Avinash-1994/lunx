/**
 * Conformance check for the zero-dependency CLI parser: every case is run
 * through both our parser and yargs, and the resulting argv is compared.
 * Run with: npx tsx scripts/verify-internal-cli.mjs
 */
import yargsFactory from 'yargs';
import ours from '../src/lib/cli-args.ts';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** Keys yargs adds that we do not need to match exactly. */
const IGNORED = new Set(['$0', '--']);

function normalize(argv) {
    const out = {};
    for (const [k, v] of Object.entries(argv)) {
        if (IGNORED.has(k)) continue;
        out[k] = v;
    }
    return out;
}

/** Declares the same options on both parsers, parses `args`, compares. */
async function compare(name, declare, args) {
    const ourParser = ours(args);
    declare(ourParser);
    const ourArgv = normalize(await ourParser.parse(args));

    const y = yargsFactory(args);
    declare(y);
    const theirArgv = normalize(await y.parseAsync(args));

    // Compare only the keys both parsers were told about, plus `_`.
    const keys = new Set([...Object.keys(ourArgv), ...Object.keys(theirArgv)]);
    const diffs = [];
    for (const key of keys) {
        const a = JSON.stringify(ourArgv[key]);
        const b = JSON.stringify(theirArgv[key]);
        if (a !== b) diffs.push(`${key}: ours=${a} yargs=${b}`);
    }
    check(name, diffs.length === 0, diffs.join('; '));
}

const devOptions = (p) =>
    p
        .option('port', { type: 'number', description: 'Server port' })
        .option('root', { alias: 'r', type: 'string', description: 'Project root' })
        .option('strictPort', { type: 'boolean', default: false })
        .option('quiet', { type: 'boolean', default: false })
        .option('open', { alias: 'o', type: 'boolean', default: false });

await compare('no args -> defaults only', devOptions, []);
await compare('--port 3000', devOptions, ['--port', '3000']);
await compare('--port=3000', devOptions, ['--port=3000']);
await compare('boolean flag', devOptions, ['--quiet']);
await compare('short alias -o', devOptions, ['-o']);
await compare('short alias with value -r ./app', devOptions, ['-r', './app']);
await compare('--no-open negation', devOptions, ['--no-open']);
await compare('camelCase option --strictPort', devOptions, ['--strictPort']);
await compare('mixed flags', devOptions, ['--port', '8080', '-o', '--quiet', '-r', 'src']);
await compare('positional lands in _', devOptions, ['somefile.ts']);
await compare('passthrough after --', devOptions, ['--port', '1', '--', '--raw', '-x']);

const kebabOptions = (p) =>
    p
        .option('include-dist', { type: 'boolean', default: false })
        .option('dir', { type: 'string', default: 'src' })
        .option('ci', { type: 'boolean', default: false });

await compare('kebab flag --include-dist', kebabOptions, ['--include-dist']);
await compare('kebab defaults', kebabOptions, []);
await compare('kebab with value', kebabOptions, ['--dir', 'lib', '--ci']);

const choiceOptions = (p) =>
    p.option('severity', { type: 'string', choices: ['critical', 'high', 'medium', 'low', 'off'], default: 'high' });

await compare('choices valid', choiceOptions, ['--severity', 'critical']);
await compare('choices default', choiceOptions, []);

// ── Behaviour our parser owns (not compared to yargs) ───────────────────────

// camelCase and kebab spellings are both readable.
{
    const p = ours(['--include-dist']);
    kebabOptions(p);
    const argv = await p.parse(['--include-dist']);
    check('kebab readable as camelCase', argv.includeDist === true, JSON.stringify(argv.includeDist));
    check('kebab readable as kebab', argv['include-dist'] === true);
}

// Grouped short booleans.
{
    const p = ours(['-oq']);
    devOptions(p);
    const argv = await p.parse(['-oq']);
    // `q` is not a declared alias, so yargs sets `q` but not `quiet`; we match that.
    check('grouped shorts -oq', argv.open === true && argv.o === true && argv.q === true, JSON.stringify({ open: argv.open, o: argv.o, q: argv.q }));
}

// Invalid choice is rejected.
{
    let message = '';
    const p = ours(['--severity', 'bogus']).fail((m) => {
        message = m;
    });
    choiceOptions(p);
    await p.parse(['--severity', 'bogus']);
    check('invalid choice rejected', message.includes('severity') && message.includes('bogus'), message);
}

// Bad number is rejected.
{
    let message = '';
    const p = ours(['--port', 'abc']).fail((m) => {
        message = m;
    });
    devOptions(p);
    await p.parse(['--port', 'abc']);
    check('non-numeric --port rejected', message.includes('number'), message);
}

// Unknown argument in strict mode.
{
    let message = '';
    const p = ours(['--nope']).strict().fail((m) => {
        message = m;
    });
    devOptions(p);
    await p.parse(['--nope']);
    check('strict rejects unknown flag', message.includes('Unknown argument'), message);
}

// demandCommand.
{
    let message = '';
    const p = ours([])
        .command('dev', 'Start dev server', () => {}, () => {})
        .demandCommand(1, 'You must specify a command')
        .fail((m) => {
            message = m;
        });
    await p.parse([]);
    check('demandCommand fires with no command', message === 'You must specify a command', message);
}

// Command dispatch with its own options.
{
    let received = null;
    const p = ours(['dev', '--port', '4000', '-o']).command(
        'dev',
        'Start dev server',
        (y) => devOptions(y),
        (args) => {
            received = args;
        },
    );
    await p.parse(['dev', '--port', '4000', '-o']);
    check('command handler receives parsed options', received?.port === 4000 && received?.open === true, JSON.stringify(received?.port));
    check('command name is in _', received?._[0] === 'dev', JSON.stringify(received?._));
}

// Nested subcommands (lunx security scan --dir lib).
{
    let received = null;
    const p = ours([]).command('security', 'Security commands', (y) =>
        y
            .command('audit', 'Audit', () => {}, () => {
                received = { cmd: 'audit' };
            })
            .command(
                'scan',
                'Scan',
                (y2) => y2.option('dir', { type: 'string', default: 'src' }).option('ci', { type: 'boolean', default: false }),
                (args) => {
                    received = { cmd: 'scan', dir: args.dir, ci: args.ci };
                },
            ),
    );
    await p.parse(['security', 'scan', '--dir', 'lib', '--ci']);
    check(
        'nested subcommand dispatch',
        received?.cmd === 'scan' && received?.dir === 'lib' && received?.ci === true,
        JSON.stringify(received),
    );

    const p2 = ours([]).command('security', 'Security commands', (y) =>
        y.command('audit', 'Audit', () => {}, () => {
            received = { cmd: 'audit' };
        }),
    );
    await p2.parse(['security', 'audit']);
    check('nested subcommand without options', received?.cmd === 'audit', JSON.stringify(received));
}

// Command positional placeholder: `why <module>`.
{
    let received = null;
    const p = ours([]).command(
        'why <module>',
        'Trace a module',
        (y) => y.positional('module', { type: 'string' }),
        (args) => {
            received = args;
        },
    );
    await p.parse(['why', 'lodash']);
    check('positional placeholder bound', received?.module === 'lodash', JSON.stringify(received?.module));

    let message = '';
    const p2 = ours([])
        .command('why <module>', 'Trace a module', () => {}, () => {})
        .fail((m) => {
            message = m;
        });
    await p2.parse(['why']);
    check('missing required positional rejected', message.includes('module'), message);
}

// Help text renders the commands and options.
{
    const p = ours([])
        .command('dev', 'Start development server', () => {}, () => {})
        .command('build', 'Build for production', () => {}, () => {})
        .option('port', { type: 'number', description: 'Server port', default: 5173 })
        .version('1.0.3')
        .help();
    const help = p.renderHelp();
    check('help lists commands', help.includes('dev') && help.includes('Start development server'));
    check('help lists options with default', help.includes('--port') && help.includes('5173'));
    check('help mentions version', help.includes('--version'));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
