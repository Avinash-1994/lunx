/**
 * `lunx create` / `create-lunx`: scaffold a project from a starter
 * (./starters.ts). Interactive by default; `--template` (and a name) make it
 * non-interactive.
 */

import fs from 'node:fs';
import path from 'node:path';
import kleur from '../lib/colors.js';
import { closeUI, select, text } from './ui.js';
import { findStarter, STARTERS, type Starter } from './starters.js';
import { packageManager, validProjectName, writeStarter } from './scaffold.js';

export interface CreateOptions {
    template?: string;
    /** false: JavaScript, for starters that offer it. Asked when unset. */
    ts?: boolean;
    /** Asked when unset (and the starter supports it). */
    tailwind?: boolean;
    cwd?: string;
}

export async function createLunxProject(initialName?: string, options: CreateOptions = {}): Promise<void> {
    const cwd = options.cwd ?? process.cwd();
    const interactive = !options.template;
    try {
        console.log(kleur.bold().magenta('\n  lunx create\n'));

        let name = initialName ?? (interactive ? await text('Project name:', 'my-lunx-app') : '');
        let dir = path.resolve(cwd, name || '.');
        if (name === '.' || !name) {
            dir = cwd;
            name = path.basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
        }
        const nameError = validProjectName(name);
        if (nameError) throw new Error(`Invalid project name "${name}": ${nameError}`);
        if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) throw new Error(`${path.relative(cwd, dir) || '.'} already exists and is not empty`);

        let starter: Starter | undefined;
        if (options.template) {
            starter = findStarter(options.template);
            if (!starter) throw new Error(`Unknown template "${options.template}". Templates: ${STARTERS.map((s) => s.id).join(', ')}`);
        } else {
            const labels = STARTERS.map(describe);
            const picked = await select('Template:', labels);
            starter = STARTERS[labels.indexOf(picked)]!;
        }

        let ts = options.ts ?? true;
        if (starter.js && options.ts === undefined && interactive) {
            ts = (await select('Language:', ['TypeScript', 'JavaScript'])) === 'TypeScript';
        }
        let tailwind = options.tailwind ?? false;
        if (starter.tailwind && options.tailwind === undefined && interactive) {
            tailwind = (await select('Add Tailwind CSS?', ['No', 'Yes'])) === 'Yes';
        }
        if (!starter.js && options.ts === false) console.log(kleur.yellow(`  ${starter.label} starts in TypeScript only.`));
        if (!starter.tailwind && options.tailwind) console.log(kleur.yellow(`  Tailwind CSS is not set up for ${starter.label}; add it after scaffolding.`));

        writeStarter(starter, dir, { name, ts, tailwind });

        const pm = packageManager();
        const rel = path.relative(cwd, dir);
        console.log(kleur.green(`\n  Created ${name} (${starter.label}${starter.js ? `, ${ts ? 'TypeScript' : 'JavaScript'}` : ''}${tailwind && starter.tailwind ? ', Tailwind CSS' : ''}).`));
        console.log('\n  Next steps:\n');
        if (rel) console.log(`    cd ${rel}`);
        console.log(`    ${pm} install`);
        console.log(`    ${pm === 'npm' ? 'npm run' : pm} dev\n`);
    } finally {
        closeUI();
    }
}

function describe(s: Starter): string {
    const note = s.ownCli ? ' (runs its own CLI)' : '';
    return `${s.label}${note}`;
}

/** `create-lunx [name] [--template x] [--js|--ts] [--tailwind]` */
export function parseCreateArgs(argv: string[]): { name?: string; options: CreateOptions } {
    const options: CreateOptions = {};
    let name: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        const [flag, inline] = arg.split('=', 2) as [string, string | undefined];
        if (flag === '--template' || flag === '-t' || flag === '--framework') options.template = inline ?? argv[++i];
        else if (flag === '--ts' || flag === '--typescript') options.ts = true;
        else if (flag === '--js' || flag === '--no-ts' || flag === '--javascript') options.ts = false;
        else if (flag === '--tailwind') options.tailwind = true;
        else if (flag === '--no-tailwind') options.tailwind = false;
        else if (!arg.startsWith('-') && name === undefined) name = arg;
        else throw new Error(`Unknown option ${arg}`);
    }
    return { name, options };
}
