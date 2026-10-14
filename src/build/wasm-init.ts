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
