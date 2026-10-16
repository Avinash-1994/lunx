#!/usr/bin/env node
/**
 * The `lunx` binary. An up-to-date `lunx build` (same arguments and env vars
 * as the last build, no input changed) is answered here, in CommonJS with
 * only `fs` and `path` loaded, ~30 ms after Node starts; its output is
 * restored from `.lunx/build-output` if it was removed. Everything else goes
 * to the full CLI (cli.ts), which also records what this checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type Entry, inputsOf, same, outputCurrent, invocation, lastBuildFile } from './build/stamps.cjs';

const PASS_THROUGH = /^--(root|outDir|out-dir)(=.*)?$/;

/** The project root, if these `lunx build` arguments are ones this path handles (only where the output goes). */
function rootOf(args: string[]): string | null {
    let root = process.cwd();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        const m = PASS_THROUGH.exec(arg);
        if (!m) return null;
        const value = m[2] !== undefined ? m[2].slice(1) : args[++i];
        if (value === undefined) return null;
        if (m[1] === 'root') root = path.resolve(process.cwd(), value);
    }
    return root;
}

function upToDate(): boolean {
    if (process.argv[2] !== 'build' || process.env.LUNX_BUILD_CACHE === '0') return false;
    const args = process.argv.slice(3);
    const root = rootOf(args);
    if (!root) return false;
    try {
        const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
        const last = JSON.parse(fs.readFileSync(lastBuildFile(root), 'utf8'));
        if (last.invocation !== invocation(version, args)) return false;
        const entry: Entry = JSON.parse(fs.readFileSync(last.entry, 'utf8'));
        const inputs = inputsOf(root, entry.outDir);
        if (!inputs || !same(entry.inputs, inputs)) return false;
        const state = outputCurrent(last.entry, entry);
        if (!state) return false;
        const where = path.relative(process.cwd(), entry.outDir) || '.';
        const ms = Math.round(process.uptime() * 1000);
        console.log(
            state === 'restored'
                ? `\n  ✓ Up to date: nothing changed since the last build; ${where} restored from the build cache (${ms} ms). Use --force to rebuild.\n`
                : `\n  ✓ Up to date: nothing changed since the last build (${where}, ${ms} ms). Use --force to rebuild.\n`,
        );
        return true;
    } catch {
        return false;
    }
}

if (!upToDate()) void import('./cli.js');
