/**
 * Who may talk to the dev server, as Vite does since its 2025 fixes
 * (CVE-2025-24010): by default only pages on localhost may read responses
 * cross-origin, and requests whose Host header names another domain are refused,
 * so a website the developer visits cannot read the app's source through DNS
 * rebinding.
 *
 *   server: { allowedHosts: ['.example.test'] | true, cors: true | false | { origin } }
 */

const LOCAL_ORIGIN = /^https?:\/\/(?:(?:[^:/]+\.)?localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface AccessOptions {
    host?: string;
    allowedHosts?: string[] | true;
    cors?: boolean | { origin?: string | RegExp | Array<string | RegExp> | boolean };
}

/** Whether a request's Host header is one the server answers. */
export function hostAllowed(hostHeader: string | undefined, options: AccessOptions): boolean {
    if (!hostHeader || options.allowedHosts === true) return true;
    const hostname = hostHeader.startsWith('[') ? hostHeader.slice(1, hostHeader.indexOf(']')) : hostHeader.replace(/:\d+$/, '');
    const name = hostname.toLowerCase();
    if (IPV4.test(name) || name.includes(':')) return true; // an IP: no DNS to rebind
    if (name === 'localhost' || name.endsWith('.localhost')) return true;
    if (options.host && options.host !== '0.0.0.0' && options.host.toLowerCase() === name) return true;
    return (options.allowedHosts ?? []).some((h) => {
        const allowed = h.toLowerCase();
        return allowed.startsWith('.') ? name === allowed.slice(1) || name.endsWith(allowed) : name === allowed;
    });
}

/** The `Access-Control-Allow-Origin` value for a request's Origin, or null (no CORS headers). */
export function corsOrigin(origin: string | undefined, options: AccessOptions): string | null {
    const cors = options.cors;
    if (cors === false) return null;
    if (cors === true) return '*';
    if (!origin) return null;
    const rule = typeof cors === 'object' && cors.origin !== undefined ? cors.origin : LOCAL_ORIGIN;
    if (rule === true) return origin;
    if (rule === false) return null;
    const rules = Array.isArray(rule) ? rule : [rule];
    return rules.some((r) => (typeof r === 'string' ? r === origin : r.test(origin))) ? origin : null;
}
