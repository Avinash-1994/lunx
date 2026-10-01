import fs from 'fs/promises';
import path from 'path';
import { log } from '../utils/logger.js';

export async function initProject(cwd: string) {
    log.info('Initializing project', { cwd });

    const pkgPath = path.join(cwd, 'package.json');
    let framework = 'vanilla';
    let isTs = false;

    try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (deps.react) framework = 'react';
        else if (deps.vue) framework = 'vue';
        else if (deps.svelte) framework = 'svelte';
        else if (deps.preact) framework = 'preact';

        if (deps.typescript) isTs = true;
    } catch (e) {
        log.warn('No package.json found, assuming vanilla JS');
    }

    log.info(`Detected framework: ${framework} ${isTs ? '(TypeScript)' : ''}`);

    // Detect entry point
    // index.html first: it is the real entry of a web app (it names the
    // scripts, styles and mount point); a script entry loses all of that.
    const candidates = [
        'index.html',
        'src/main.tsx', 'src/main.ts', 'src/main.jsx', 'src/main.js',
        'src/index.tsx', 'src/index.ts', 'src/index.jsx', 'src/index.js',
    ];

    let entry = 'src/main.tsx';
    for (const c of candidates) {
        try {
            await fs.access(path.join(cwd, c));
            entry = c;
            break;
        } catch (e) { }
    }

    // Prompt for CSS Framework if not detected
    // In a real implementation, we would use 'prompts' or 'inquirer'
    // For now, we'll simulate or check args, but let's assume we want to ask
    // Since we can't easily do interactive prompts in this environment without a library,
    // we'll check for a flag or default to asking via console (mocked here)

    // Check if user wants Tailwind (mock logic for now, or check args)
    // In a real CLI: const response = await prompts({ ... })
    const useTailwind = process.argv.includes('--tailwind');

    if (useTailwind) {
        log.info('Tailwind CSS requested via flag');
        const { TailwindPlugin } = await import('../plugins/css/tailwind.js');
        const tailwind = new TailwindPlugin();
        await tailwind.apply(cwd);
    }

    const config = {
        root: '.',
        entry: [entry],
        mode: 'development',
        outDir: 'dist',
        port: 5173,
        // Add css config if needed
    };

    const cfgPath = path.join(cwd, 'lunx.config.json');
    if (await fs.access(cfgPath).then(() => true).catch(() => false)) {
        log.warn('Config file already exists, skipping creation');
        return;
    }

    await fs.writeFile(cfgPath, JSON.stringify(config, null, 2));
    log.success('Created lunx.config.json');

    if (useTailwind) {
        log.success('Initialized project with Tailwind CSS');
    }
}
