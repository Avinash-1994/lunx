/**
 * lightningcss, loaded straight from its platform package.
 *
 * The package's own entry picks that package with detect-libc, which loads
 * child_process (with net and dgram) only to tell glibc from musl: ~15ms of
 * every command that touches CSS, against ~1ms for the binary itself. The
 * same check is made here from /usr/bin/ldd; whenever it cannot tell, the
 * package entry decides as usual.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';

type LightningCss = Pick<typeof import('lightningcss'), 'transform'>;

let loaded: LightningCss | null = null;

export function lightningcss(): LightningCss {
    return (loaded ??= load());
}

function load(): LightningCss {
    const require = createRequire(import.meta.url);
    try {
        const parts: string[] = [process.platform, process.arch];
        if (process.platform === 'linux') {
            const libc = linuxLibc();
            if (!libc) throw new Error('unknown libc');
            parts.push(libc === 'musl' ? 'musl' : process.arch === 'arm' ? 'gnueabihf' : 'gnu');
        } else if (process.platform === 'win32') {
            parts.push('msvc');
        }
        // Resolved from lightningcss itself, as its entry does: the version it pins.
        const native = createRequire(require.resolve('lightningcss'))(`lightningcss-${parts.join('-')}`);
        if (typeof native?.transform !== 'function') throw new Error('unexpected binding');
        return { transform: native.transform };
    } catch {
        return require('lightningcss');
    }
}

function linuxLibc(): 'glibc' | 'musl' | null {
    try {
        const ldd = fs.readFileSync('/usr/bin/ldd', 'utf8');
        if (ldd.includes('musl')) return 'musl';
        if (ldd.includes('GNU C Library') || ldd.includes('GLIBC')) return 'glibc';
    } catch {
        // no ldd script (distroless images): let detect-libc work it out
    }
    return null;
}
