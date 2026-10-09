/**
 * Write a starter (./starters.ts) to disk as a ready-to-install project.
 */

import fs from 'node:fs';
import path from 'node:path';
import { type Starter, type StarterOptions } from './starters.js';

/** The lunx-dev version projects depend on: this package's own. */
export function lunxVersion(): string {
    try {
        return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    } catch {
        return 'latest';
    }
}

/** npm package-name rules, which also keep the name safe to put in source files. */
export function validProjectName(name: string): string | null {
    if (!name) return 'a project name is required';
    if (name.length > 214) return 'the name is longer than 214 characters';
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return 'use lowercase letters, digits, "-", "_" and "." (it becomes the package name)';
    return null;
}

/** The package manager that ran this command, for the "next steps" it prints. */
export function packageManager(): 'npm' | 'pnpm' | 'yarn' | 'bun' {
    const agent = process.env.npm_config_user_agent ?? '';
    if (agent.startsWith('pnpm')) return 'pnpm';
    if (agent.startsWith('yarn')) return 'yarn';
    if (agent.startsWith('bun')) return 'bun';
    return 'npm';
}

export function writeStarter(starter: Starter, dir: string, options: StarterOptions): string[] {
    const o: StarterOptions = { ...options, ts: starter.js ? options.ts : true, tailwind: !!starter.tailwind && options.tailwind };
    if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
        throw new Error(`${dir} already exists and is not empty`);
    }

    const files: Record<string, string> = {
        ...starter.files(o),
        '.gitignore': ['node_modules', 'dist', 'build', '.lunx', '.DS_Store', ''].join('\n'),
    };
    const pm = packageManager();
    const run = pm === 'npm' ? 'npm run' : pm;
    files['README.md'] = [
        `# ${o.name}`,
        '',
        `${starter.label}, built with [lunx](https://www.npmjs.com/package/lunx-dev).`,
        '',
        '```sh',
        `${pm} install`,
        `${run} dev       # dev server with hot reload`,
        `${run} build     # production build`,
        ...(starter.scripts?.build?.includes('--lib') || starter.id === 'edge' ? [] : [`${run} preview   # serve the build`]),
        '```',
        '',
    ].join('\n');

    const pkg: Record<string, unknown> = {
        name: o.name,
        version: '0.0.0',
        private: true,
        ...(starter.type === null ? {} : { type: starter.type ?? 'module' }),
        scripts: { dev: 'lunx dev', build: 'lunx build', preview: 'lunx preview', ...starter.scripts },
        dependencies: sortKeys(starter.dependencies(o)),
        devDependencies: sortKeys({ 'lunx-dev': `^${lunxVersion()}`, ...starter.devDependencies?.(o) }),
    };
    if (starter.id === 'library') {
        const main = './dist/index.js';
        Object.assign(pkg, {
            private: undefined,
            files: ['dist'],
            main,
            module: main,
            ...(o.ts ? { types: './dist/index.d.ts' } : {}),
            exports: { '.': { ...(o.ts ? { types: './dist/index.d.ts' } : {}), import: main } },
        });
        delete pkg.private;
    }
    if (!Object.keys(pkg.dependencies as object).length) delete pkg.dependencies;
    files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';

    for (const [rel, content] of Object.entries(files)) {
        const target = path.join(dir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    return Object.keys(files).sort();
}

function sortKeys(record: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
