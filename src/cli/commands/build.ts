import path from 'path';
import { performance } from 'perf_hooks';
import { createRequire } from 'module';
import fs from 'fs';
import { gzipSync } from 'zlib';

const require = createRequire(import.meta.url);

async function printBuildSummary(outDir: string, elapsed: number) {
  if (!fs.existsSync(outDir)) return;

  const APP_EXTENSIONS = ['.js', '.mjs', '.cjs', '.css', '.html', '.wasm', '.map'];
  const EXCLUDE_NAMES = ['lunx-sbom', 'lunx-csp', 'lunx-sri', 'lunx-headers', '_headers', '.htaccess'];

  const files = (fs.readdirSync(outDir, { recursive: true }) as string[])
    .filter(f => typeof f === 'string' && !f.includes('node_modules'))
    .filter(f => {
      const ext = path.extname(f);
      const base = path.basename(f);
      return APP_EXTENSIONS.includes(ext) &&
             !EXCLUDE_NAMES.some(ex => base.includes(ex));
    })
    .map(f => {
      const full = path.join(outDir, f);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) return null;
        const content = fs.readFileSync(full);
        const gz = gzipSync(content).length;
        return { name: f, size: stat.size, gz };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b!.size - a!.size)
    .slice(0, 20);

  console.log();
  for (const file of files) {
    const name = file!.name.padEnd(55);
    const kb = (file!.size / 1024).toFixed(2).padStart(8);
    const gzkb = (file!.gz / 1024).toFixed(2).padStart(8);
    console.log(`  ${name} ${kb} kB │ gzip: ${gzkb} kB`);
  }
  console.log(`\n  ✓ built in ${elapsed}ms\n`);
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
}

export default {
  options: (yargs: any) => {
    return yargs
      .option('root', {
        alias: 'r',
        type: 'string',
        description: 'Project root directory (defaults to the current directory)'
      })
      .option('outDir', {
        type: 'string',
        description: 'Output directory, relative to the project root'
      })
      .option('prod', {
        type: 'boolean',
        description: 'Force production mode',
        default: true
      })
      .option('profile', {
        type: 'boolean',
        description: 'Show detailed build profile',
        default: false
      })
      .option('compat-rollup', {
        type: 'boolean',
        description: 'Byte-identical Vite/Rollup output format',
        default: false
      })
      .option('watch', {
        alias: 'w',
        type: 'boolean',
        description: 'Watch mode: rebuild on file changes',
        default: false
      });
  },
  handler: async (args: any) => {
    const { wrapError, printHeroError } = await import('../../core/errors/hero-errors.js');
    const { Telemetry } = await import('../../ai/telemetry.js');

    if (!args.profile && !args.verbose) {
      process.env.LUNX_FAST_PATH = '1';
    }

    const root = args.root ? path.resolve(process.cwd(), args.root) : process.cwd();

    // Meta-frameworks run their own toolchain (see meta-frameworks/delegate.ts).
    const { detectMetaFramework, delegate } = await import('../../meta-frameworks/delegate.js');
    const meta = detectMetaFramework(root);
    if (meta) {
      const { loadConfig: loadForDelegate } = await import('../../config/index.js');
      const optOut = await loadForDelegate(root).then((c: any) => c?.delegate === false).catch(() => false);
      if (!optOut) {
        process.exitCode = await delegate(meta, 'build', root, { port: undefined });
        return;
      }
    }

    const telemetry = new Telemetry(root);
    await telemetry.init();
    telemetry.start();

    try {
      const { loadConfig } = await import('../../config/index.js');
      const config = await loadConfig(root);
      config.root = root;
      config.mode = args.prod !== false ? 'production' : config.mode || 'development';
      if (args.outDir) (config as any).outDir = args.outDir;

      if (args['compat-rollup']) {
        (config as any).compatRollup = true;
      }

      // Module Federation validation
      if (config.federation) {
        const { validateFederationConfig } = await import('../../federation/index.js');
        const mfErrors = validateFederationConfig(config.federation as any);
        if (mfErrors.length > 0) {
          console.error('\n❌ Module Federation config errors:');
          mfErrors.forEach((e: string) => console.error(`  • ${e}`));
          process.exit(1);
        }
      }

      // Env loading
      const { loadEnv, warnSensitiveEnv } = await import('../../env.js');
      const env = loadEnv(config.mode as 'development' | 'production' | 'test', root);
      warnSensitiveEnv(env);
      (config as any).__envDefines = { ...env.define, ...env.metaEnv };

      const { build: runBuild } = await import('../../build/bundler.js');
      const t0 = performance.now();
      const result = await runBuild(config);
      const elapsed = Math.round(performance.now() - t0);

      const outDir = path.resolve(root, (config as any).outDir || 'dist');
      await printBuildSummary(outDir, elapsed);

      if (args.profile) {
        printProfileReport(result);
      }

      console.log('\n💡  Tip: Run `npx lunx preview` to serve the build locally.');
      console.log('💡  Tip: Run `npx lunx audit` to generate a full audit report.');

      await telemetry.stop(true);

      // NEW-04: --watch mode
      if (args.watch) {
        console.log('\n  Watching for changes... (Ctrl+C to stop)\n');
        const chokidar = await import('../../lib/watcher.js');
        const srcDir = path.join(root, 'src');
        const watcher = chokidar.watch(srcDir, { ignoreInitial: true, persistent: true });

        const rebuild = async (filePath: string) => {
          console.log(`  [lunx] Changed: ${path.relative(root, filePath)}`);
          const t1 = performance.now();
          try {
            await runBuild(config);
            const ms = Math.round(performance.now() - t1);
            console.log(`  ✓ Rebuilt in ${ms}ms`);
          } catch (e: any) {
            console.error(`  ✗ Build failed: ${e.message}`);
          }
        };

        watcher.on('change', rebuild).on('add', rebuild);
        await new Promise(() => {}); // keep alive
      }
    } catch (e: any) {
      const heroError = wrapError(e);
      printHeroError(heroError);
      await telemetry.stop(false, {}, [heroError.message]);
      process.exit(1);
    }
  }
};
