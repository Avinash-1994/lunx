#!/usr/bin/env node
import { createLunxProject, parseCreateArgs } from './create/index.js';

try {
    const { name, options } = parseCreateArgs(process.argv.slice(2));
    await createLunxProject(name, options);
} catch (err: any) {
    console.error(`\n  ${err?.message ?? err}\n`);
    process.exit(1);
}
