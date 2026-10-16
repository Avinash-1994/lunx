/**
 * `import init from './module.wasm?init'`, as in Vite: `init(imports)`
 * resolves to the `WebAssembly.Instance`. `url` is a JavaScript expression
 * for the module's URL (or a `data:` URL).
 */
export function wasmInitModule(url: string): string {
    return `const url = ${url};
export default async function init(imports = {}) {
  let result;
  if (url.startsWith('data:')) {
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    result = await WebAssembly.instantiate(bytes, imports);
  } else {
    const response = await fetch(url);
    if ((response.headers.get('Content-Type') || '').startsWith('application/wasm') && 'instantiateStreaming' in WebAssembly) {
      result = await WebAssembly.instantiateStreaming(response, imports);
    } else {
      result = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
    }
  }
  return result.instance;
}
`;
}

/**
 * `import { add } from './module.wasm'`: the WebAssembly ESM integration, as in
 * Vite 8.1. The module's imports come from the JS modules its import section
 * names (relative to the .wasm file), and its exports are the module's exports.
 * Read from the binary at build time, so they are real named exports.
 * `url` is a JavaScript expression for the module's URL. The default export is
 * that URL (what a plain `.wasm` import gave before), unless the module exports
 * `default` itself.
 */
export function wasmEsmModule(bytes: Uint8Array, url: string): string {
    const mod = new WebAssembly.Module(new Uint8Array(bytes));
    const importModules = [...new Set(WebAssembly.Module.imports(mod).map((i) => i.module))];
    const exportNames = WebAssembly.Module.exports(mod).map((e) => e.name);
    const lines: string[] = [];
    importModules.forEach((name, i) => lines.push(`import * as __wasm_import_${i} from ${JSON.stringify(name)};`));
    lines.push(wasmInitModule(url).replace('export default async function init', 'async function init'));
    const importObject = importModules.map((name, i) => `${JSON.stringify(name)}: __wasm_import_${i}`).join(', ');
    lines.push(`const __wasm = (await init({ ${importObject} })).exports;`);
    exportNames.forEach((name, i) => {
        lines.push(`const __wasm_export_${i} = __wasm[${JSON.stringify(name)}];`);
        lines.push(`export { __wasm_export_${i} as ${JSON.stringify(name)} };`);
    });
    if (!exportNames.includes('default')) lines.push(`export default url;`);
    return lines.join('\n') + '\n';
}
