import native from './index.js';

const NativePluginRuntime = native.PluginRuntime;

type NativePluginRuntimeType = any;

/**
 * Secure WASM Runtime wrapper.
 * Requires the Rust native binary; JS fallback throws on construct.
 */
export class PluginRuntime {
    private runtime: NativePluginRuntimeType;

    constructor() {
        if (!NativePluginRuntime) {
            throw new Error('WASM plugin runtime requires the native binary');
        }
        this.runtime = new NativePluginRuntime();
    }

    verify(wasmBytes: Buffer): boolean {
        return this.runtime.verifyPlugin(wasmBytes);
    }

    execute(wasmBytes: Buffer, input: string, timeoutMs: number = 100): string {
        return this.runtime.execute(wasmBytes, input, timeoutMs);
    }
}
