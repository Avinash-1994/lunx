import net from 'node:net';

let wildcardHost: Promise<string> | null = null;

/**
 * The address that accepts connections on every interface.
 *
 * `::` binds dual-stack, which matters because browsers resolve `localhost` to
 * ::1 first — an IPv4-only `0.0.0.0` bind leaves HMR WebSockets hanging. But
 * hosts with IPv6 disabled (many Docker containers and CI runners) refuse `::`
 * with EAFNOSUPPORT, so fall back to `0.0.0.0` there. Probed once per process.
 */
export function anyHost(): Promise<string> {
    wildcardHost ??= new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve('0.0.0.0'));
        probe.listen(0, '::', () => probe.close(() => resolve('::')));
    });
    return wildcardHost;
}

/** Map a configured host (unset, `0.0.0.0`, `::`) to the address to bind. */
export async function resolveBindHost(host: string | undefined): Promise<string> {
    if (!host || host === '0.0.0.0' || host === '::') return anyHost();
    return host;
}

/** A host suitable for printing in a URL the user can click. */
export function displayHost(bindHost: string): string {
    if (bindHost === '::' || bindHost === '0.0.0.0') return 'localhost';
    return bindHost.includes(':') ? `[${bindHost}]` : bindHost;
}

/**
 * Whether `port` can be bound on `host`. Only "address in use" means try the
 * next port; any other bind error is a configuration problem and is thrown so
 * the caller does not walk the whole port range reporting a misleading cause.
 */
export function isPortFree(port: number, host: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') resolve(false);
            else reject(err);
        });
        probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
}
