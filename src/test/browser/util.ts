/** `node:util` for test files in the browser: `inspect` (values in messages and diffs). */

const custom = Symbol.for('nodejs.util.inspect.custom');

interface InspectOptions {
    depth?: number;
    compact?: number | boolean;
    breakLength?: number;
    sorted?: boolean;
}

function inspect(value: unknown, options: InspectOptions = {}): string {
    const depth = options.depth ?? 2;
    const breakLength = options.breakLength ?? 80;
    const seen = new Set<unknown>();
    const fmt = (v: any, level: number, indent: string): string => {
        if (v === null) return 'null';
        if (v === undefined) return 'undefined';
        if (typeof v === 'string') return level === 0 ? v : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
        if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
        if (typeof v === 'bigint') return `${v}n`;
        if (typeof v === 'boolean') return String(v);
        if (typeof v === 'symbol') return v.toString();
        if (typeof v === 'function') return `[${v.constructor?.name === 'AsyncFunction' ? 'AsyncFunction' : v.prototype && /^class\s/.test(Function.prototype.toString.call(v)) ? 'class' : 'Function'}: ${v.name || '(anonymous)'}]`;
        if (typeof v[custom] === 'function') return String(v[custom](depth - level, options, inspect));
        if (seen.has(v)) return '[Circular *1]';
        if (v instanceof Date) return isNaN(+v) ? 'Invalid Date' : v.toISOString();
        if (v instanceof RegExp) return String(v);
        if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
        if (typeof Node !== 'undefined' && v instanceof Node) return (v as any).outerHTML ?? `[${v.nodeName}]`;
        if (level > depth) return Array.isArray(v) ? '[Array]' : `[${v.constructor?.name ?? 'Object'}]`;
        seen.add(v);
        const inner = indent + '  ';
        let parts: string[];
        let open: string;
        let close: string;
        if (Array.isArray(v)) {
            parts = v.map((x) => fmt(x, level + 1, inner));
            [open, close] = ['[', ']'];
        } else if (v instanceof Map) {
            parts = [...v].map(([k, x]) => `${fmt(k, level + 1, inner)} => ${fmt(x, level + 1, inner)}`);
            [open, close] = [`Map(${v.size}) {`, '}'];
        } else if (v instanceof Set) {
            parts = [...v].map((x) => fmt(x, level + 1, inner));
            [open, close] = [`Set(${v.size}) {`, '}'];
        } else {
            let keys = Object.keys(v);
            if (options.sorted) keys = keys.sort();
            parts = keys.map((k) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: ${fmt(v[k], level + 1, inner)}`);
            const name = v.constructor && v.constructor !== Object ? `${v.constructor.name} ` : Object.getPrototypeOf(v) === null ? '[Object: null prototype] ' : '';
            [open, close] = [`${name}{`, '}'];
        }
        seen.delete(v);
        if (!parts.length) return `${open}${close}`;
        const oneLine = `${open} ${parts.join(', ')} ${close}`;
        return oneLine.length + indent.length <= breakLength && !oneLine.includes('\n') ? oneLine : `${open}\n${parts.map((p) => inner + p).join(',\n')}\n${indent}${close}`;
    };
    return fmt(value, 0, '');
}
inspect.custom = custom;

const format = (...args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
const isDeepStrictEqual = (a: unknown, b: unknown) => inspect(a, { depth: 20, sorted: true }) === inspect(b, { depth: 20, sorted: true });

export { inspect, format, isDeepStrictEqual };
export default { inspect, format, isDeepStrictEqual };
