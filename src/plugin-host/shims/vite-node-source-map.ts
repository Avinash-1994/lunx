/** `vite-node/source-map`: modules carry a sourceURL; no extra stack-trace hooks needed. */

export function installSourcemapsSupport(_options?: unknown): void {}

export function withInlineSourcemap<T>(result: T): T {
    return result;
}

export default { installSourcemapsSupport, withInlineSourcemap };
