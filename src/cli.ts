#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// BUG-CLI-02: no top-level `import type` — inline the type annotation instead
async function printAuditReport(
  report: import('./audit/types.js').AuditReport
) {
  console.log('\n🛡️  Audit Report');
  Object.entries(report.groups).forEach(([key, group]: [string, any]) => {
    if (!group) return;
    const color = group.score >= 90 ? '\x1b[32m' : group.score >= 70 ? '\x1b[33m' : '\x1b[31m';
    console.log(`\n${group.name} (Score: ${color}${group.score}\x1b[0m)`);
    group.results.forEach((r: any) => {
      const icon = r.status === 'PASS' ? '✅' : r.status === 'WARN' ? '⚠️ ' : '❌';
      console.log(`  ${icon} ${r.title}`);
    });
  });
}

function printProfileReport(result: any) {
  if (!result.events) return;
  const profileEvents = result.events.filter((e: any) => e.decision === 'performance');
  if (profileEvents.length === 0) return;
  console.log('\n⏱️  Build Profile');
  console.log('='.repeat(40));
  const tableData = profileEvents.map((e: any) => ({
    Stage: e.stage.toUpperCase(),
    'Duration (ms)': e.data.duration.toFixed(2),
    Description: e.reason.split(' took ')[0]
  }));
  console.table(tableData);
  const totalBuild = profileEvents.find((e: any) => e.reason.startsWith('Total Build'));
  if (totalBuild) {
    console.log(`\n🚀 Total Build Time: \x1b[32m${totalBuild.data.duration.toFixed(2)}ms\x1b[0m`);
  }
  if (result.pluginMetrics && result.pluginMetrics.length > 0) {
    console.log('\n🔌 Plugin Performance (Top 5 Slowest)');
    const pluginTable = result.pluginMetrics.slice(0, 5).map((m: any) => ({
      Plugin: m.plugin,
      'Total Time (ms)': m.totalTimeMs.toFixed(2),
      'Avg Time (ms)': m.avgTimeMs.toFixed(2),
      Calls: m.callCount
    }));
    console.table(pluginTable);
  }
}

// FEAT-CLI-01: Levenshtein distance for "Did you mean?" suggestions
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

const ALL_COMMANDS = [
  'dev', 'build', 'preview', 'analyze', 'why', 'check', 'ssr',
  'init', 'bootstrap', 'css', 'inspect', 'report', 'audit',
  'verify', 'test', 'doctor', 'security', 'migrate'
];

async function main() {
  // BUG-CLI-01: short-circuit block REMOVED — yargs is the single handler for all commands

  const { log } = await import('./utils/logger.js');
  const { default: yargs, hideBin } = await import('./lib/cli-args.js');

  // Import extracted command modules
  const { default: devCmd }      = await import('./cli/commands/dev.js');
  const { default: buildCmd }    = await import('./cli/commands/build.js');
  const { default: previewCmd }  = await import('./cli/commands/preview.js');
  const { default: securityCmd } = await import('./cli/commands/security.js');
  const { default: migrateCmd }  = await import('./cli/commands/migrate.js');

  const pkg = require('../package.json');

  const argv = await (yargs as any)(hideBin(process.argv))
    // BUG-CLI-04: --version flag
    .version(pkg.version)
    .alias('version', 'v')

    // FEAT-CLI-01: "Did you mean?" .fail() handler
    .fail((msg: string, err: Error, y: any) => {
      const typed = process.argv[2];
      
      // If it's a known command that failed due to validation, print the actual error
      if (msg && !msg.includes('Unknown argument')) {
        console.error(`\nError: ${msg}\n`);
        y.showHelp();
        process.exit(1);
      }

      if (typed && !typed.startsWith('-')) {
        const closest = ALL_COMMANDS
          .map(c => ({ c, d: levenshtein(typed, c) }))
          .sort((a, b) => a.d - b.d)[0];
        if (closest.d <= 3 && closest.c !== typed) {
          console.error(`\nUnknown command: ${typed}`);
          console.error(`Did you mean: lunx ${closest.c} ?\n`);
          process.exit(1);
        }
      }
      console.error(`\n${msg}\n`);
      y.showHelp();
      process.exit(1);
    })

    // FEAT-CLI-05: extracted command files
    .command('dev', 'Start development server', devCmd.options, devCmd.handler)
    .command('build', 'Build for production', buildCmd.options, buildCmd.handler)
    .command('preview', 'Serve production build locally', previewCmd.options, previewCmd.handler)
    .command('security', 'Security commands (audit, scan, cve, sbom, plugin-audit, fix, headers, report)', securityCmd.builder, () => {})
    .command(
      'migrate',
      'Migrate config and plugins from older Lunx versions',
      migrateCmd.options,
      migrateCmd.handler
    )

    // ── Remaining inline commands ──────────────────────────────────────────────
    .command(
      'analyze',
      'Analyze bundle composition and module sizes',
      (yargs: any) => {
        return yargs.option('json', {
          type: 'boolean',
          description: 'Output as JSON instead of HTML report',
          default: false
        });
      },
      async (args: any) => {
        const { loadConfig } = await import('./config/index.js');
        const { generateAnalyzeReport } = await import('./commands/analyze.js');
        try {
          const config = await loadConfig(process.cwd());
          console.log('🔄 Gathering build metadata for analysis...');
          const { build: runBuild } = await import('./build/bundler.js');
          const result = await runBuild(config);
          await generateAnalyzeReport(result, args.json);
        } catch (e: any) {
          log.error(`Analysis failed: ${e.message}`);
          process.exit(1);
        }
      }
    )
    .command(
      'why <module>',
      'Print the full import chain from entry to a target module',
      (yargs: any) => yargs.positional('module', { type: 'string', describe: 'Module path to trace' }),
      async (args: any) => {
        const { loadConfig } = await import('./config/index.js');
        const { resolveProjectGraph } = await import('./resolve/build-graph.js');
        const config = await loadConfig(process.cwd());
        // Resolve the graph here rather than asking the user to run a build:
        // the engine keeps its graph in memory, so `lunx build` in a previous
        // process could never have satisfied this command.
        const { graph, entryIds } = await resolveProjectGraph(config);
        const target = args.module as string;
        // Walk from the graph's own entry node ids. Seeding from `config.entry`
        // meant starting at "index.html", which is not a module and has no
        // node, so every lookup missed and every module was "not found".
        // Node ids are content hashes, so matching the target against an id
        // could never succeed; the file path is what the user typed.
        const pathOf = (id: string) => graph.nodes?.get(id)?.path ?? id;
        const matches = (id: string) => {
          const p = pathOf(id).replace(/\\/g, '/').toLowerCase();
          const t = target.replace(/\\/g, '/').toLowerCase();
          // A bare package name should match the package, not any path that
          // merely contains the word.
          return p.endsWith(t) || p.includes(`/node_modules/${t}/`) || p.includes(t);
        };

        let found = false;
        for (const entry of entryIds) {
          const queue: string[][] = [[entry]];
          const visited = new Set<string>();
          while (queue.length) {
            const chain = queue.shift()!;
            const node = chain[chain.length - 1];
            if (visited.has(node)) continue;
            visited.add(node);
            if (chain.length > 1 && matches(node)) {
              console.log('\n  Import chain:');
              chain.forEach((m, i) =>
                console.log(`  ${'  '.repeat(i)}${i === 0 ? '→' : '└'} ${path.relative(process.cwd(), pathOf(m)) || pathOf(m)}`)
              );
              found = true; break;
            }
            const graphNode = graph.nodes?.get(node);
            for (const dep of (graphNode?.edges?.map((e: any) => e.to) ?? [])) queue.push([...chain, dep]);
          }
          if (found) break;
        }
        if (!found) { console.error(`\n  Module not found: ${target}`); process.exit(1); }
        process.exit(0);
      }
    )
    .command(
      'check',
      'Pre-build validation: resolve + type-check without emitting output',
      (yargs: any) => yargs
        .option('no-types', { type: 'boolean', default: false, description: 'Skip TypeScript type checking' })
        .option('no-circular', { type: 'boolean', default: false, description: 'Skip circular import detection' }),
      async (args: any) => {
        const { loadConfig } = await import('./config/index.js');
        const config = await loadConfig(process.cwd());
        config.mode = 'production';
        let exitCode = 0;
        process.stderr.write('[lunx:check] Resolving module graph...\n');
        const { FrameworkPipeline } = await import('./core/pipeline/framework-pipeline.js');
        const pipeline = await FrameworkPipeline.auto(config);
        if (!args['no-types']) {
          // `npx tsc` goes to the registry when typescript is absent from the
          // project and prints npx's own "This is not the tsc command you are
          // looking for", which tells the user nothing about their project.
          // Resolve the compiler from the project and say plainly when it is
          // missing.
          const { createRequire } = await import('module');
          const projectRequire = createRequire(path.join(process.cwd(), "package.json"));
          let tscPath: string | null = null;
          try {
            tscPath = projectRequire.resolve('typescript/lib/tsc.js');
          } catch {
            tscPath = null;
          }

          if (!tscPath) {
            process.stderr.write(
              '[lunx:check] Skipping type-check: TypeScript is not installed in this project.\n' +
                '             Add it with `npm i -D typescript`, or pass --no-types.\n'
            );
          } else {
            try {
              const { execFileSync } = await import('child_process');
              process.stderr.write('[lunx:check] Running TypeScript type-check...\n');
              execFileSync(process.execPath, [tscPath, '--noEmit'], {
                cwd: process.cwd(),
                stdio: 'inherit',
              });
              process.stderr.write('[lunx:check] TypeScript ✅\n');
            } catch { exitCode = 1; }
          }
        }
        if (!args['no-circular']) {
          try {
            const engine = pipeline.getEngine();
            const graph = engine.getGraph?.();
            if (graph) {
              const cycles: string[][] = [];
              const visited = new Set<string>(), stack = new Set<string>();
              function dfs(id: string, path: string[]) {
                if (stack.has(id)) { cycles.push([...path, id]); return; }
                if (visited.has(id)) return;
                visited.add(id); stack.add(id);
                for (const dep of (graph?.nodes?.get(id)?.edges?.map((e: any) => e.to) ?? [])) dfs(dep, [...path, id]);
                stack.delete(id);
              }
              for (const id of graph.nodes?.keys() ?? []) dfs(id, []);
              if (cycles.length > 0) {
                process.stderr.write(`[lunx:check] ❌ ${cycles.length} circular import(s) detected:\n`);
                cycles.slice(0, 5).forEach(c => process.stderr.write(`  ${c.join(' → ')}\n`));
                exitCode = 1;
              } else {
                process.stderr.write('[lunx:check] Circular imports ✅\n');
              }
            }
          } catch (e: any) { process.stderr.write(`[lunx:check] Graph check skipped: ${e.message}\n`); }
        }
        process.stderr.write(exitCode === 0 ? '\n[lunx:check] All checks passed ✅\n' : '\n[lunx:check] Check failed ❌\n');
        process.exit(exitCode);
      }
    )
    .command(
      'ssr',
      'Start SSR server for meta-frameworks',
      (yargs: any) => {
        return yargs
          .option('port', { type: 'number', description: 'Server port', default: 3000 })
          .option('framework', { type: 'string', description: 'Framework type (nextjs|nuxt|remix)', default: 'nextjs' })
          .option('prod', { type: 'boolean', description: 'Production mode', default: false });
      },
      async (args: any) => {
        const { handleSSRCommand } = await import('./commands/ssr.js');
        await handleSSRCommand(args);
      }
    )
    .command(
      'init',
      'Initialize project configuration',
      (yargs: any) => yargs.option('yes', { type: 'boolean', description: 'Use defaults', default: false }),
      async () => {
        const { initProject: runInit } = await import('./init/index.js');
        await runInit(process.cwd());
      }
    )
    .command(
      'bootstrap',
      'Create a new project from a template',
      (yargs: any) => yargs
        .option('template', { type: 'string', description: 'Template to use (react, vanilla)', default: 'react' })
        .option('name', { type: 'string', description: 'Project name', demandOption: true }),
      async (args: any) => {
        const { bootstrapProject } = await import('./init/bootstrap.js');
        const targetDir = path.join(process.cwd(), args.name);
        await bootstrapProject(targetDir, args.template);
      }
    )
    .command(
      'css',
      'CSS utilities',
      (yargs: any) => {
        return yargs
          .command(
            'purge',
            'Analyze and remove unused CSS',
            () => {},
            async () => {
              const { purgeCSSCommand } = await import('./cli/css-cli.js');
              await purgeCSSCommand(process.cwd());
            }
          )
          .demandCommand(1, 'You must specify a subcommand: detect, list, add, purge, migrate');
      }
    )
    .command(
      'inspect',
      'Inspect the dependency graph',
      (yargs: any) => yargs.option('filter', { alias: 'f', type: 'string', description: 'Filter modules by path/ID' }),
      async (args: any) => {
        const { inspectProject } = await import('./cli/inspect.js');
        await inspectProject(args.filter);
      }
    )
    .command(
      'report',
      'Generate a build report from the latest session',
      () => {},
      async () => {
        const { Telemetry } = await import('./ai/telemetry.js');
        const { ReportAssembler } = await import('./ai/reporter/assembler.js');
        const { LLMNarrator } = await import('./ai/reporter/narrator.js');
        const { DEFAULT_AI_CONFIG } = await import('./ai/config.js');
        const { AuditEngine } = await import('./audit/index.js');

        const session = await Telemetry.getLatestSession(process.cwd());
        if (!session) { log.error('No build history found.', { category: 'ai' }); return; }

        const trends = await Telemetry.getTrends(process.cwd(), session);
        const audits = await AuditEngine.runAll(process.cwd());
        const fullReport = ReportAssembler.assemble(session, trends, audits);
        const narrator = new LLMNarrator(DEFAULT_AI_CONFIG);
        const summary = await narrator.narrate(fullReport);

        console.log('\n📊 Build Report');
        console.log(summary);
      }
    )
    .command(
      'audit',
      'Run comprehensive audits (Accessibility, Performance, SEO)',
      (yargs: any) => yargs.option('url', { type: 'string', description: 'URL to audit' }),
      async (args: any) => {
        const { AuditEngine } = await import('./audit/index.js');
        const target = args.url || process.cwd();
        log.info(`Auditing ${target}...`, { category: 'audit' });
        const report = await AuditEngine.runAll(target);
        printAuditReport(report);
      }
    )
    .command(
      'verify',
      'Verify project health and configuration',
      (yargs: any) => yargs
        .option('ci', { type: 'boolean', description: 'CI mode (exit 1 on failure)', default: false })
        .option('strict', { type: 'boolean', description: 'Strict mode (warnings = failures)', default: false })
        .option('explain', { type: 'boolean', description: 'Show detailed explanations', default: false })
        .option('fix', { type: 'boolean', description: 'Auto-fix issues where possible', default: false }),
      async (args: any) => {
        const { verify } = await import('./commands/verify.js');
        await verify({ ci: args.ci, strict: args.strict, explain: args.explain, fix: args.fix });
      }
    )
    .command(
      'test',
      'Run tests using Lunx Custom Runner',
      (yargs: any) => yargs.option('watch', { type: 'boolean', description: 'Watch mode', default: false }),
      async () => {
        const { run } = await import('./test/runner.js');
        const rawArgs = process.argv.slice(process.argv.indexOf('test') + 1);
        await run(rawArgs);
      }
    )
    .command(
      'doctor',
      'Run project health diagnostics',
      () => {},
      async () => {
        const { runDoctor } = await import('./commands/doctor.js');
        await runDoctor(process.cwd());
      }
    )
    .command(
      'create [name]',
      'Create a new Lunx project',
      (yargs: any) => yargs
        .positional('name', { type: 'string', description: 'Project name' })
        // `--template` is what every other scaffolder calls this flag
        // (create-vite, create-next-app), so accept it as an alias rather than
        // rejecting it with "Unknown argument".
        .option('framework', { type: 'string', alias: 'template', description: 'Framework to use' })
        .option('ts', { type: 'boolean', description: 'Use TypeScript', default: true })
        .option('tailwind', { type: 'boolean', description: 'Add Tailwind CSS', default: false }),
      async (args: any) => {
        const { runCreate } = await import('./commands/create.js');
        await runCreate(args.name, { framework: args.framework, ts: args.ts, tailwind: args.tailwind });
      }
    )
    .command(
      'info',
      'Print environment info for bug reports',
      () => {},
      async () => {
        const { runInfo } = await import('./commands/info.js');
        await runInfo();
      }
    )
    .command(
      'env',
      'List and validate environment variables',
      () => {},
      async () => {
        const { runEnv } = await import('./commands/env.js');
        await runEnv();
      }
    )
    .demandCommand(1, 'You must specify a command')
    .strict()
    .help()
    .argv;
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
