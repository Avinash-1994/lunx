/**
 * `fetch` accessor.
 *
 * Node >= 20 (our declared engine floor) always ships a global fetch, so the
 * former `node-fetch` fallback was dead weight in the dependency tree.
 */

let cachedFetch: typeof fetch | null = null;

export async function getFetch(): Promise<typeof fetch> {
  if (cachedFetch) return cachedFetch;

  if (typeof globalThis.fetch === 'function') {
    cachedFetch = globalThis.fetch.bind(globalThis) as typeof fetch;
    return cachedFetch;
  }

  throw new Error(
    `No global fetch available on Node ${process.versions.node}. Lunx requires Node >= 20.`
  );
}
