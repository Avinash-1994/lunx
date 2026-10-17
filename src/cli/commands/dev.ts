import path from 'path';
import { existsSync } from 'fs';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';

const require = createRequire(import.meta.url);

export default {
  options: (yargs: any) => {
    return yargs
      .option('port', {
        type: 'number',
        description: 'Server port'
      })
      .option('root', {
        alias: 'r',
        type: 'string',
        description: 'Project root directory'
      })
      .option('strictPort', {
        type: 'boolean',
        description: 'Fail if the requested port is unavailable instead of trying another port',
        default: false
      })
      .option('quiet', {
        type: 'boolean',
        description: 'Suppress non-error output',
        default: false
      })
      .option('verbose', {
        type: 'boolean',
        description: 'Show detailed debug output',
        default: false
      })
      .option('open', {
        alias: 'o',
        type: 'boolean',
        description: 'Open browser automatically on dev server start',
        default: false
      })
      .option('bundle', {
        type: 'boolean',
        description: 'Serve the app as bundles (server.bundle): fastest first load for large apps'
      });
  },
  handler: async (args: any) => {
    const mark = (name: string) => { if (process.env.LUNX_TIMINGS) process.stderr.write(`  [lunx:timings] @${name.padEnd(34)} ${performance.now().toFixed(1)} ms\n`); };
    mark('dev handler');
    const { log } = await import('../../utils/logger.js');
    try {
      if (args.quiet) {
        process.env.LUNX_QUIET = 'true';
      }
      if (args.verbose) {
        process.env.DEBUG = '*';
      }

      const root = args.root
        ? path.resolve(process.cwd(), args.root)
        : process.cwd();

      // Meta-frameworks run their own toolchain (see meta-frameworks/delegate.ts).
      const { maybeDelegate } = await import('../../meta-frameworks/delegate.js');
      if (await maybeDelegate('dev', root, args.port)) return;
      mark('meta-framework check');

      // Load lunx.config.ts BEFORE starting the server so that
      // server.port from the user's config is respected when binding the port.
      let userPort = args.port || 5173;
      let userCfg: any;
      try {
        const { loadConfig } = await import('../../config/index.js');
        userCfg = await loadConfig(root);
        userPort = args.port || userCfg.server?.port || (userCfg as any).port || 5173;
      } catch {
        // Config may not exist yet — fall back to default
      }

      const cfg = {
        root,
        port: userPort,
        mode: 'development',
        server: { host: '0.0.0.0', strictPort: args.strictPort, port: userPort, ...(args.bundle !== undefined ? { bundle: args.bundle } : {}) },
        // The dev server starts from this config instead of loading it again (~50 ms).
        __loadedConfig: userCfg,
      } as any;

      // A first start pre-bundles the dependencies with Rolldown (bundled dev builds with it):
      // loading it now, while the server starts, takes ~100 ms off the first page. A restart
      // with the pre-bundle cached does not need it.
      const cacheMeta = path.join(root, userCfg?.cacheDir ?? path.join('.lunx', 'cache'), '_metadata.json');
      if (args.bundle || userCfg?.server?.bundle || !existsSync(cacheMeta)) {
        void Promise.all([import('rolldown'), import('rolldown/experimental')]).catch(() => {});
      }

      mark('config (port)');
      const minimalDevServer = await import('../../dev/devServer.minimal.js');
      mark('dev server module');
      const t0 = performance.now();
      await minimalDevServer.startDevServer(cfg);
      const elapsed = Math.round(performance.now() - t0);

      const version = require('../../../package.json').version;
      const adapter = minimalDevServer.detectedAdapter ?? 'none';
      const port = cfg.port || 5173;

      console.log(
        `\n  ⚡ lunx v${version}  ` +
        `adapter: ${adapter}  ` +
        `port: ${port}\n` +
        `     http://localhost:${port}\n` +
        `     ready in ${elapsed}ms\n`
      );

      if (args.open) {
        const url = `http://localhost:${port}`;
        const { exec } = await import('child_process');
        const cmd = process.platform === 'darwin' ? 'open'
          : process.platform === 'win32' ? 'start'
          : 'xdg-open';
        exec(`${cmd} ${url}`);
      }

      if (!args.quiet) {
        console.log('\n💡  Tip: Run `npx lunx audit --url http://localhost:' + port + '` to generate an audit report.');
      }
    } catch (e: any) {
      log.error(e.message);
      process.exit(1);
    }
  }
};
