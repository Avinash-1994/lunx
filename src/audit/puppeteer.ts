/**
 * Puppeteer is only needed by `lunx audit`, and it downloads a ~170 MB browser
 * on install, so it is not a dependency of lunx. It was nonetheless imported
 * statically here, which made every module in this folder fail to load with
 * ERR_MODULE_NOT_FOUND in a real install.
 */
export type PuppeteerModule = typeof import('puppeteer');

let cached: PuppeteerModule | null = null;

export async function loadPuppeteer(): Promise<PuppeteerModule> {
    if (cached) return cached;
    try {
        cached = (await import('puppeteer')) as unknown as PuppeteerModule;
        return cached;
    } catch {
        throw new Error(
            '`lunx audit` needs Puppeteer, which is not installed.\n' +
            '  Install it with:  npm i -D puppeteer'
        );
    }
}
