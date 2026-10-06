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

async function runLibraryBuild(root: string, lib: any, config: any) {
  if (!lib.entry) {
    lib.entry = ['src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.jsx', 'src/main.ts', 'src/main.js', 'index.ts', 'index.js']
      .find((f) => fs.existsSync(path.join(root, f)));
    if (!lib.entry) throw new Error('Library mode needs an entry: `lunx build --lib src/index.ts`, or `lib.entry` in lunx.config');
  }
  const { detectFramework } = await import('../../core/framework-detector.js');
  const framework = config.framework || (await detectFramework(root));
  const { buildLibrary, suggestExports } = await import('../../build/library.js');
  const result = await buildLibrary(root, lib, framework);
  const outDir = path.resolve(root, lib.outDir);
  console.log();
  for (const f of result.files) {
    console.log(`  ${path.relative(root, path.join(outDir, f.file)).padEnd(48)} ${f.format.padEnd(4)} ${(f.size / 1024).toFixed(2).padStart(8)} kB`);
  }
  console.log(`\n  ✓ library built in ${Math.round(result.durationMs)}ms\n`);
  if (result.problems.length) {
    console.warn('  ⚠ package.json points at files the build did not write:');
    for (const p of result.problems) console.warn(`    • ${p}`);
    console.warn(`\n  Suggested "exports":\n${JSON.stringify(suggestExports(result, path.relative(root, outDir) || '.'), null, 2).split('\n').map((l) => '    ' + l).join('\n')}\n`);
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
      .option('lib', {
        description: 'Library mode: build a package (optionally give the entry: --lib src/index.ts)',
      })
      .option('formats', {
        type: 'string',
        description: 'Library formats, comma-separated: es,cjs,umd,iife',
      })
      .option('name', {
        type: 'string',
        description: 'Library mode: global variable name for the umd / iife formats',
      })
      .option('dts', {
        type: 'boolean',
        description: 'Library mode: emit .d.ts files (default: when tsconfig.json exists)',
      })
      .option('force', {
        type: 'boolean',
        description: 'Rebuild even if nothing changed since the last build',
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
    const mark = (name: string) => { if (process.env.LUNX_TIMINGS) console.log(`  [lunx:timings] @${name.padEnd(31)} ${(process.uptime() * 1000).toFixed(1).padStart(7)} ms`); };
    mark('handler');

    // Meta-frameworks run their own toolchain (see meta-frameworks/delegate.ts).
    const { maybeDelegate } = await import('../../meta-frameworks/delegate.js');
    if (await maybeDelegate('build', root, undefined)) return;
    mark('meta-framework check');

    // Nothing changed since the last build with these options: its output stands.
    const buildCache = await import('../../build/build-cache.js');
    const cacheOptions = { lib: args.lib ?? null, formats: args.formats ?? null, dts: args.dts ?? null, name: args.name ?? null, outDir: args.outDir ?? null, prod: args.prod, compatRollup: !!args['compat-rollup'] };
    // --force rebuilds but still records the result for the next build.
    const cached = buildCache.cacheEnabled() && !args.watch ? buildCache.checkBuild(root, cacheOptions) : null;
    mark('build cache check');
    if (cached?.hit && !args.force) {
      console.log(`\n  ✓ Up to date: nothing changed since the last build (${path.relative(process.cwd(), cached.outDir!) || '.'}, ${Math.round(process.uptime() * 1000)} ms). Use --force to rebuild.\n`);
      return;
    }

    const telemetry = new Telemetry(root);
    await telemetry.init();
    telemetry.start();
    mark('telemetry');

    try {
      const { loadConfig } = await import('../../config/index.js');
      const config = await loadConfig(root);
      mark('config');
      config.root = root;
      config.mode = args.prod !== false ? 'production' : config.mode || 'development';
      if (args.outDir) (config as any).outDir = args.outDir;

      if (args['compat-rollup']) {
        (config as any).compatRollup = true;
      }

      // Library mode: a package for npm instead of an app.
      const libOption = (config as any).lib || args.lib ? { ...(config as any).lib } : null;
      if (libOption) {
        if (typeof args.lib === 'string') libOption.entry = args.lib;
        if (args.formats) libOption.formats = String(args.formats).split(',').map((f: string) => f.trim()).filter(Boolean);
        if (args.dts !== undefined) libOption.dts = args.dts;
        if (args.name) libOption.name = args.name;
        libOption.outDir ??= (config as any).outDir || 'dist';
        await runLibraryBuild(root, libOption, config);
        if (cached) buildCache.recordBuild(root, cached.pending, path.resolve(root, libOption.outDir), (config as any).build?.cache !== false);
        await telemetry.stop(true);
        if (args.watch) {
          const { watch } = await import('../../lib/watcher.js');
          const outDir = path.resolve(root, libOption.outDir);
          const watcher = watch(root, { ignoreInitial: true, ignored: ['**/node_modules/**', '**/.git/**', `${outDir}/**`, '**/.lunx/**'] });
          let timer: NodeJS.Timeout | null = null;
          let running: Promise<void> = Promise.resolve();
          // Sources and the files that configure them; not logs or other output written in the project.
          const relevant = /\.([mc]?[jt]sx?|vue|svelte|css|pcss|postcss|scss|sass|less|styl|stylus|json|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf)$/i;
          const rebuild = (file: string) => {
            if (!relevant.test(file)) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              running = running.then(async () => {
                console.log(`  [lunx] changed: ${path.relative(root, file)}`);
                try {
                  await runLibraryBuild(root, libOption, config);
                } catch (e: any) {
                  console.error(`  ✗ ${e.message}`);
                }
              });
            }, 50);
          };
          watcher.on('change', rebuild).on('add', rebuild).on('unlink', rebuild);
          console.log('  Watching for changes... (Ctrl+C to stop)\n');
          await new Promise(() => {});
        }
        return;
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
      if (process.env.LUNX_TIMINGS) console.log(`  [lunx:timings] ${'cli start, config, env'.padEnd(32)} ${(process.uptime() * 1000).toFixed(1).padStart(7)} ms`);
      const result = await runBuild(config);
      const elapsed = Math.round(performance.now() - t0);

      const outDir = path.resolve(root, (config as any).outDir || 'dist');
      if (cached) buildCache.recordBuild(root, cached.pending, outDir, (config as any).build?.cache !== false);
      const tSummary = performance.now();
      await printBuildSummary(outDir, elapsed);
      if (process.env.LUNX_TIMINGS) console.log(`  [lunx:timings] ${'size summary'.padEnd(32)} ${(performance.now() - tSummary).toFixed(1).padStart(7)} ms`);

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
