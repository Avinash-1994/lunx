/**
 * Worker thread for CompilePool: compiles framework components (Vue, Svelte,
 * Solid / Preact JSX, …) with the same UniversalTransformer the main thread
 * uses, so the output is identical whichever thread compiles a file.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { UniversalTransformer } from '../core/universal-transformer.js';

interface Job {
    id: number;
    file: string;
    code: string;
    framework: string;
}

const transformer = new UniversalTransformer(workerData.root, { cache: false });

// Load the compilers this build needs before the first file arrives.
const SAMPLES: Record<string, [string, string]> = {
    vue: ['__lunx_warm__.vue', '<template><div></div></template>'],
    svelte: ['__lunx_warm__.svelte', '<div></div>'],
};
for (const fw of workerData.warm ?? []) {
    const sample = SAMPLES[fw];
    if (sample) transformer.transform({ filePath: sample[0], code: sample[1], framework: fw as any, root: workerData.root, isDev: false }).catch(() => {});
}

parentPort!.on('message', async (job: Job) => {
    try {
        const out = await transformer.transform({ filePath: job.file, code: job.code, framework: job.framework as any, root: workerData.root, isDev: false });
        parentPort!.postMessage({ id: job.id, code: out.code });
    } catch (err: any) {
        parentPort!.postMessage({ id: job.id, error: { message: err?.message ?? String(err), stack: err?.stack } });
    }
});
