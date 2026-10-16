/**
 * A shared cache for the build's compile results (src/build/build-cache.ts
 * TransformCache: framework components, Angular's linker), so CI machines and
 * teammates reuse each other's work:
 *
 *   cache: { remote: { provider: 'http', baseUrl: 'https://cache.example.com/lunx', token } }
 *   cache: { remote: { provider: 's3', bucket, region, endpoint? } }   // AWS_* credentials from the env
 *
 * Entries are keyed by content and compiler versions, so a stale one is never
 * used. `readOnly: true` (e.g. for pull requests) downloads but never uploads.
 * A cache that cannot be reached is a slower build, not a failure.
 */

import crypto from 'node:crypto';

export interface RemoteCacheOptions {
    provider?: 'http' | 's3' | 'lunx-cloud' | false;
    baseUrl?: string;
    endpoint?: string;
    bucket?: string;
    region?: string;
    token?: string;
    readOnly?: boolean;
}

export interface RemoteCache {
    readOnly: boolean;
    get(key: string): Promise<Buffer | null>;
    put(key: string, data: Buffer): Promise<void>;
}

let active: RemoteCache | null = null;

/** The build's remote cache, from `cache.remote`; throws on a configuration it cannot use. */
export function configureRemoteCache(options: RemoteCacheOptions | undefined | null): RemoteCache | null {
    active = null;
    if (!options || !options.provider) return null;
    const timeout = Number(process.env.LUNX_REMOTE_CACHE_TIMEOUT ?? 10_000);
    if (options.provider === 'http') {
        if (!options.baseUrl) throw new Error('cache.remote: provider "http" needs baseUrl');
        const base = options.baseUrl.replace(/\/+$/, '');
        const token = options.token ?? process.env.LUNX_REMOTE_CACHE_TOKEN;
        const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
        active = {
            readOnly: !!options.readOnly,
            async get(key) {
                const res = await fetch(`${base}/${key}`, { headers, signal: AbortSignal.timeout(timeout) }).catch(() => null);
                return res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
            },
            async put(key, data) {
                await fetch(`${base}/${key}`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: new Uint8Array(data), signal: AbortSignal.timeout(timeout) }).catch(() => null);
            },
        };
        return active;
    }
    if (options.provider === 's3') {
        if (!options.bucket) throw new Error('cache.remote: provider "s3" needs bucket');
        const accessKey = process.env.AWS_ACCESS_KEY_ID;
        const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
        if (!accessKey || !secretKey) throw new Error('cache.remote: provider "s3" needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment');
        const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
        const endpoint = (options.endpoint ?? `https://s3.${region}.amazonaws.com`).replace(/\/+$/, '');
        const sign = (method: string, key: string, body: Buffer) => s3Request(method, `${endpoint}/${options.bucket}/${key}`, region, accessKey, secretKey, process.env.AWS_SESSION_TOKEN, body);
        active = {
            readOnly: !!options.readOnly,
            async get(key) {
                const { url, headers } = sign('GET', key, Buffer.alloc(0));
                const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) }).catch(() => null);
                return res?.ok ? Buffer.from(await res.arrayBuffer()) : null;
            },
            async put(key, data) {
                const { url, headers } = sign('PUT', key, data);
                await fetch(url, { method: 'PUT', headers, body: new Uint8Array(data), signal: AbortSignal.timeout(timeout) }).catch(() => null);
            },
        };
        return active;
    }
    throw new Error(`cache.remote: unknown provider "${options.provider}" (use "http" or "s3")`);
}

export function remoteCache(): RemoteCache | null {
    return active;
}

/** AWS Signature Version 4 for one S3 request (path-style URL). */
function s3Request(method: string, url: string, region: string, accessKey: string, secretKey: string, sessionToken: string | undefined, body: Buffer) {
    const u = new URL(url);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = crypto.createHash('sha256').update(body).digest('hex');
    const headers: Record<string, string> = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join('');
    const canonicalPath = u.pathname.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/');
    const canonical = [method, canonicalPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
    const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac('sha256', key).update(data).digest();
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
    const { host: _host, ...sent } = headers;
    return { url: u.href, headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } };
}
