import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// CFG-05: Preview reads outDir from lunx.config
export default {
  options: (yargs: any) => {
    return yargs
      .option('root', {
        alias: 'r',
        type: 'string',
        description: 'Project root directory (defaults to the current directory)'
      })
      .option('port', {
        alias: 'p',
        type: 'number',
        description: 'Port to serve on',
        default: 4173
      })
      .option('host', {
        type: 'string',
        description: 'Host to bind to',
        default: 'localhost'
      })
      .option('open', {
        alias: 'o',
        type: 'boolean',
        description: 'Open browser automatically',
        default: false
      })
      .option('outDir', {
        type: 'string',
        description: 'Output directory to serve (overrides config)',
      });
  },
  handler: async (args: any) => {
    const { preview } = await import('../../commands/preview.js');

    const path = await import('path');
    const root = args.root ? path.resolve(process.cwd(), args.root) : process.cwd();

    // Read outDir from config if not provided via CLI arg
    let outDir = args.outDir;
    if (!outDir) {
      try {
        const { loadConfig } = await import('../../config/index.js');
        const config = await loadConfig(root);
        outDir = (config as any).outDir ?? 'dist';
      } catch {
        outDir = 'dist';
      }
    }

    await preview({
      port: args.port,
      host: args.host,
      open: args.open,
      outDir: path.resolve(root, outDir),
    });
  }
};
