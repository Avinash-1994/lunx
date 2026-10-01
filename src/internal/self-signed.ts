/**
 * Zero-dependency self-signed certificate generation, replacing `selfsigned`.
 *
 * Node can create keys and sign bytes but has no API for *issuing* an X.509
 * certificate, so the TBSCertificate structure is DER-encoded here (RFC 5280)
 * and signed with sha256WithRSAEncryption. The SubjectPublicKeyInfo is taken
 * straight from Node's SPKI export, so no RSA key encoding is hand-rolled.
 *
 * Certificates are for local development only; browsers will still warn until
 * the certificate is trusted manually.
 */

import { generateKeyPairSync, randomBytes, sign as cryptoSign, createPrivateKey } from 'node:crypto';

// ── Minimal DER encoder ─────────────────────────────────────────────────────

const enum Tag {
    Boolean = 0x01,
    Integer = 0x02,
    BitString = 0x03,
    OctetString = 0x04,
    Null = 0x05,
    Oid = 0x06,
    Utf8String = 0x0c,
    PrintableString = 0x13,
    IA5String = 0x16,
    UtcTime = 0x17,
    GeneralizedTime = 0x18,
    Sequence = 0x30,
    Set = 0x31,
}

/** DER length: short form below 128, else long form with a leading byte count. */
function encodeLength(length: number): Buffer {
    if (length < 0x80) return Buffer.from([length]);
    const bytes: number[] = [];
    let remaining = length;
    while (remaining > 0) {
        bytes.unshift(remaining & 0xff);
        remaining >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
    return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function seq(...parts: Buffer[]): Buffer {
    return tlv(Tag.Sequence, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
    return tlv(Tag.Set, Buffer.concat(parts));
}

/** Positive INTEGER; a leading 0x00 is added when the top bit would read as negative. */
function integer(value: Buffer | number): Buffer {
    let bytes = typeof value === 'number' ? Buffer.from(numberToBytes(value)) : value;
    if (bytes.length === 0) bytes = Buffer.from([0]);
    if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return tlv(Tag.Integer, bytes);
}

function numberToBytes(value: number): number[] {
    if (value === 0) return [0];
    const out: number[] = [];
    let remaining = value;
    while (remaining > 0) {
        out.unshift(remaining & 0xff);
        remaining = Math.floor(remaining / 256);
    }
    return out;
}

/** BIT STRING with zero unused bits. */
function bitString(value: Buffer): Buffer {
    return tlv(Tag.BitString, Buffer.concat([Buffer.from([0]), value]));
}

function oid(dotted: string): Buffer {
    const parts = dotted.split('.').map(Number);
    const bytes: number[] = [parts[0]! * 40 + parts[1]!];
    for (const part of parts.slice(2)) {
        if (part < 0x80) {
            bytes.push(part);
            continue;
        }
        // Base-128, high bit set on every byte but the last.
        const chunks: number[] = [];
        let remaining = part;
        while (remaining > 0) {
            chunks.unshift(remaining & 0x7f);
            remaining >>= 7;
        }
        for (let i = 0; i < chunks.length - 1; i++) chunks[i]! |= 0x80;
        bytes.push(...chunks);
    }
    return tlv(Tag.Oid, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
    const pad = (n: number) => String(n).padStart(2, '0');
    const text =
        pad(date.getUTCFullYear() % 100) +
        pad(date.getUTCMonth() + 1) +
        pad(date.getUTCDate()) +
        pad(date.getUTCHours()) +
        pad(date.getUTCMinutes()) +
        pad(date.getUTCSeconds()) +
        'Z';
    return tlv(Tag.UtcTime, Buffer.from(text, 'ascii'));
}

/** Context-specific constructed tag, e.g. [0] for the version field. */
function contextConstructed(index: number, value: Buffer): Buffer {
    return tlv(0xa0 | index, value);
}

function contextPrimitive(index: number, value: Buffer): Buffer {
    return tlv(0x80 | index, value);
}

// ── X.509 pieces ────────────────────────────────────────────────────────────

const OID = {
    commonName: '2.5.4.3',
    countryName: '2.5.4.6',
    localityName: '2.5.4.7',
    stateOrProvinceName: '2.5.4.8',
    organizationName: '2.5.4.10',
    organizationalUnitName: '2.5.4.11',
    sha256WithRSA: '1.2.840.113549.1.1.11',
    basicConstraints: '2.5.29.19',
    keyUsage: '2.5.29.15',
    extKeyUsage: '2.5.29.37',
    subjectAltName: '2.5.29.17',
    subjectKeyIdentifier: '2.5.29.14',
    serverAuth: '1.3.6.1.5.5.7.3.1',
    clientAuth: '1.3.6.1.5.5.7.3.2',
} as const;

const ATTR_OIDS: Record<string, string> = {
    commonName: OID.commonName,
    CN: OID.commonName,
    countryName: OID.countryName,
    C: OID.countryName,
    localityName: OID.localityName,
    L: OID.localityName,
    stateOrProvinceName: OID.stateOrProvinceName,
    ST: OID.stateOrProvinceName,
    organizationName: OID.organizationName,
    O: OID.organizationName,
    organizationalUnitName: OID.organizationalUnitName,
    OU: OID.organizationalUnitName,
};

export interface Attribute {
    name?: string;
    shortName?: string;
    type?: string;
    value: string;
}

function name(attributes: Attribute[]): Buffer {
    const rdns = attributes.map((attribute) => {
        const key = attribute.name ?? attribute.shortName ?? 'commonName';
        const attrOid = attribute.type ?? ATTR_OIDS[key] ?? OID.commonName;
        // UTF8String is the modern default and accepts any value we are given.
        return set(seq(oid(attrOid), tlv(Tag.Utf8String, Buffer.from(attribute.value, 'utf8'))));
    });
    return seq(...rdns);
}

const GeneralName = { dnsName: 2, ipAddress: 7 } as const;

function subjectAltName(hosts: string[]): Buffer {
    const entries = hosts.map((host) => {
        const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
        if (ipv4) {
            return contextPrimitive(GeneralName.ipAddress, Buffer.from(ipv4.slice(1, 5).map(Number)));
        }
        return contextPrimitive(GeneralName.dnsName, Buffer.from(host, 'ascii'));
    });
    return seq(...entries);
}

function extension(extOid: string, critical: boolean, value: Buffer): Buffer {
    const parts = [oid(extOid)];
    if (critical) parts.push(tlv(Tag.Boolean, Buffer.from([0xff])));
    parts.push(tlv(Tag.OctetString, value));
    return seq(...parts);
}

const algorithmSha256WithRSA = seq(oid(OID.sha256WithRSA), tlv(Tag.Null, Buffer.alloc(0)));

function toPem(der: Buffer, label: string): string {
    const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd();
    return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface GenerateOptions {
    /** Validity window in days. Default 365. */
    days?: number;
    /** RSA modulus size. Default 2048. */
    keySize?: number;
    /** Extra hostnames/IPs for the SAN extension. */
    altNames?: string[];
}

export interface Pems {
    private: string;
    public: string;
    cert: string;
}

/**
 * `selfsigned`-compatible generator.
 *
 * Every certificate gets a subjectAltName covering the common name plus
 * localhost/127.0.0.1/::1, because browsers have ignored the CN for host
 * matching since 2017 and a cert without SAN fails outright.
 */
export function generate(attributes: Attribute[] = [], options: GenerateOptions = {}): Pems {
    const attrs = attributes.length > 0 ? attributes : [{ name: 'commonName', value: 'localhost' }];
    const days = options.days ?? 365;
    const commonName = attrs.find((a) => (a.name ?? a.shortName) === 'commonName' || a.shortName === 'CN')?.value ?? 'localhost';

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: options.keySize ?? 2048,
    });

    // Node's SPKI export is already a DER SubjectPublicKeyInfo.
    const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

    const notBefore = new Date(Date.now() - 60 * 60 * 1000); // an hour of clock skew
    const notAfter = new Date(notBefore.getTime() + days * 24 * 60 * 60 * 1000);

    const hosts = [...new Set([commonName, 'localhost', '127.0.0.1', ...(options.altNames ?? [])])];
    const subject = name(attrs);

    const extensions = contextConstructed(
        3,
        seq(
            // Not a CA: cA defaults to FALSE, so an empty SEQUENCE says so.
            extension(OID.basicConstraints, true, seq()),
            extension(OID.keyUsage, true, bitString(Buffer.from([0xa0]))), // digitalSignature + keyEncipherment
            extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth), oid(OID.clientAuth))),
            extension(OID.subjectAltName, false, subjectAltName(hosts)),
        ),
    );

    const tbs = seq(
        contextConstructed(0, integer(2)), // version v3
        integer(randomBytes(16)),
        algorithmSha256WithRSA,
        subject, // issuer == subject: self-signed
        seq(utcTime(notBefore), utcTime(notAfter)),
        subject,
        spki,
        extensions,
    );

    const signature = cryptoSign('sha256', tbs, privateKey);
    const certificate = seq(tbs, algorithmSha256WithRSA, bitString(signature));

    return {
        private: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
        public: publicKey.export({ type: 'spki', format: 'pem' }) as string,
        cert: toPem(certificate, 'CERTIFICATE'),
    };
}

/** Convenience for the dev server: a cert good for these hosts. */
export function generateForHosts(hosts: string[], days = 365): Pems {
    const commonName = hosts[0] ?? 'localhost';
    return generate([{ name: 'commonName', value: commonName }], { days, altNames: hosts });
}

/** Re-exported so callers can round-trip a stored key without importing crypto. */
export { createPrivateKey };

export default { generate, generateForHosts };
