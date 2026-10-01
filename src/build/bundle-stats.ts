
import { BuildArtifact } from '../core/engine/types.js';
import { log } from '../utils/logger.js';
import kleur from '../internal/colors.js';

export function printBundleStats(artifacts: BuildArtifact[]) {
    console.log(kleur.bold().cyan('\n📦 Production Bundle Statistics'));
    console.log(kleur.gray('--------------------------------------------------'));

    const items = artifacts
        .filter(a => !a.fileName.endsWith('.map'))
        .map(a => {
            const size = a.source ? (typeof a.source === 'string' ? Buffer.byteLength(a.source) : a.source.length) : 0;
            return {
                name: a.fileName,
                size,
                type: a.type
            };
        })
        .sort((a, b) => b.size - a.size);

    const tableData = items.map(item => {
        const kb = (item.size / 1024).toFixed(2) + ' KB';
        let color = kleur.white;

        if (item.name.endsWith('.js')) color = kleur.yellow;
        if (item.name.endsWith('.css')) color = kleur.blue;
        if (item.name.endsWith('.gz') || item.name.endsWith('.br')) color = kleur.gray;

        return {
            Asset: color(item.name),
            Size: kb,
            Type: item.type
        };
    });

    console.table(tableData);

    const totalRaw = items.filter(i => !i.name.endsWith('.gz') && !i.name.endsWith('.br')).reduce((acc, i) => acc + i.size, 0);
    const totalGzip = items.filter(i => i.name.endsWith('.gz')).reduce((acc, i) => acc + i.size, 0);
    const totalBrotli = items.filter(i => i.name.endsWith('.br')).reduce((acc, i) => acc + i.size, 0);

    console.log(kleur.gray('--------------------------------------------------'));
    console.log(`${kleur.bold('Total Raw Size:')} ${(totalRaw / 1024).toFixed(2)} KB`);
    if (totalGzip > 0) console.log(`${kleur.bold('Gzip Transferred:')} ${(totalGzip / 1024).toFixed(2)} KB`);
    if (totalBrotli > 0) console.log(`${kleur.bold('Brotli Transferred:')} ${kleur.green((totalBrotli / 1024).toFixed(2) + ' KB')} 🚀`);
    console.log(kleur.gray('--------------------------------------------------\n'));
}
