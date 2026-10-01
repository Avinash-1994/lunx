/**
 * Differential check: our AST walker against `acorn-walk`.
 * Run with: node --import tsx scripts/verify-internal-astwalk.mjs
 */
import * as acorn from 'acorn';
import * as reference from 'acorn-walk';
import * as ours from '../src/internal/ast-walk.ts';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

const sources = {
    'imports + calls': `
        import a, { b as c } from 'x';
        import * as ns from 'y';
        export const f = async () => { await c(); ns.g(1, 2); };
        export default function main() { return a(f()); }
    `,
    'classes + loops': `
        class A extends B { #p = 1; static s = 2; m(x) { for (const y of x) this.#p += y; } }
        label: for (let i = 0; i < 10; i++) { if (i) continue label; else break; }
    `,
    'destructuring + templates': `
        const { a = 1, ...rest } = obj, [x, , y = 2] = arr;
        const t = \`v\${a + x}\${fn(\`\${y}\`)}\`;
        try { risky?.(); } catch ({ message }) { console.error(message); } finally { done(); }
    `,
    'generators + optional chains': `
        function* gen() { yield* other(); }
        const v = a?.b?.[c]?.(d) ?? e;
        export { gen as default };
        label2: switch (v) { case 1: break; default: }
    `,
    'dynamic import + new': `
        const m = await import('./mod.js');
        const o = new Map([[1, 2]]);
        (function iife() { return new.target; })();
    `,
};

function countByType(walker, ast, types) {
    const counts = {};
    const visitors = {};
    for (const t of types) {
        counts[t] = 0;
        visitors[t] = () => { counts[t]++; };
    }
    walker.simple(ast, visitors);
    return counts;
}

// Statement- and expression-level types, where the structural walk must agree
// with acorn-walk exactly. `Identifier` and the pattern types are excluded on
// purpose: acorn-walk routes binding positions to its Pattern visitors, so our
// superset behaviour there is expected and asserted separately below.
const TYPES = [
    'CallExpression', 'ImportDeclaration', 'ImportSpecifier',
    'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'MemberExpression',
    'FunctionDeclaration', 'ArrowFunctionExpression', 'ClassDeclaration',
    'PropertyDefinition', 'ForOfStatement', 'ForStatement', 'TemplateLiteral',
    'AwaitExpression', 'YieldExpression', 'ChainExpression',
    'LogicalExpression', 'TryStatement', 'SwitchStatement', 'NewExpression',
    'ImportExpression', 'Literal', 'VariableDeclarator', 'SpreadElement',
];

for (const [name, code] of Object.entries(sources)) {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    const expected = countByType(reference, ast, TYPES);
    const actual = countByType(ours, ast, TYPES);
    const diffs = TYPES.filter((t) => expected[t] !== actual[t]);
    check(
        `simple() matches acorn-walk: ${name}`,
        diffs.length === 0,
        diffs.length ? diffs.map((t) => `${t} ${expected[t]}!=${actual[t]}`).join(' ') : ''
    );
}

// `full` must reach every node acorn-walk reaches (it also reaches the binding
// identifiers acorn-walk hands to its Pattern visitors, hence >=).
for (const [name, code] of Object.entries(sources)) {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    let expected = 0;
    reference.full(ast, () => { expected++; });
    let actual = 0;
    ours.full(ast, () => { actual++; });
    check(`full() reaches every acorn-walk node: ${name}`, actual >= expected, `${actual} >= ${expected}`);
}

// The documented divergence, pinned so a future change to either side shows up.
{
    const ast = acorn.parse('const x = 1; function f(y) { return y; }', {
        ecmaVersion: 'latest',
        sourceType: 'module',
    });
    let ref = 0;
    reference.simple(ast, { Identifier: () => { ref++; } });
    let got = 0;
    ours.simple(ast, { Identifier: () => { got++; } });
    check(
        'binding identifiers: superset of acorn-walk, as documented',
        ref === 1 && got === 4,
        `acorn-walk ${ref} (y in return only), ours ${got} (x, f, y param, y)`
    );
}

// State threading and the visitor's node argument.
{
    const ast = acorn.parse('f(1); g(2);', { ecmaVersion: 'latest' });
    const seen = [];
    ours.simple(ast, { CallExpression: (node, state) => state.push(node.callee.name) }, undefined, seen);
    check('state is threaded through visitors', JSON.stringify(seen) === JSON.stringify(['f', 'g']), seen.join(','));
}

// A node type nobody declared a visitor for must not throw.
{
    const ast = acorn.parse('const a = 1;', { ecmaVersion: 'latest' });
    let threw = false;
    try {
        ours.simple(ast, {});
    } catch {
        threw = true;
    }
    check('missing visitors are ignored', !threw);
}

// Cycles introduced by a parent back-reference must not hang the walk.
{
    const ast = acorn.parse('h();', { ecmaVersion: 'latest' });
    ast.body[0].parent = ast;
    let count = 0;
    ours.full(ast, () => { count++; });
    check('parent back-reference does not recurse forever', count > 0, `${count} nodes`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
