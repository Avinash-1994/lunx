/**
 * Minimal replacement for `acorn-walk`'s `simple`/`full`.
 *
 * `acorn-walk` was imported by src/fix/ast-transforms.ts and src/test/coverage.ts
 * without ever being declared as a dependency, so `lunx build` died with
 * ERR_MODULE_NOT_FOUND in any real install. Both call sites use `simple` only.
 *
 * Child discovery is structural — every own property that is a node (an object
 * with a string `type`) or an array of nodes is visited — rather than driven by
 * a per-node-type key table. That keeps working when a parser emits node types
 * this file has never heard of.
 *
 * Known difference from acorn-walk: this is a strict superset at binding
 * positions. acorn-walk routes declaration and parameter names to its
 * `Pattern`/`VariablePattern` visitors, so an `Identifier` visitor does not
 * fire for `const x = 1`; here it does. Visitors for statement- and
 * expression-level types (`ImportDeclaration`, `CallExpression`,
 * `ExportNamedDeclaration`, …) fire exactly as often as in acorn-walk, which
 * is verified in scripts/verify-internal-astwalk.mjs. If you need acorn-walk's
 * pattern semantics, filter by position in the visitor.
 */

export interface AstNode {
    type: string;
}

/** Any object we have recursed into; acorn's typed nodes satisfy this. */
type AnyNode = AstNode & Record<string, unknown>;

type Visitor<S> = (node: AstNode, state: S) => void;
export type SimpleVisitors<S> = Record<string, Visitor<S>>;

function isNode(value: unknown): value is AnyNode {
    return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

/** Depth-first walk, visiting a node after its children. */
function walkNode(node: AnyNode, enter: (n: AstNode) => void): void {
    for (const key in node) {
        // `parent` back-references would make this loop forever; positional
        // metadata (`loc`, `start`, `end`, `range`) holds no nodes.
        if (key === 'parent' || key === 'loc' || key === 'range') continue;
        const value = node[key];
        if (Array.isArray(value)) {
            for (const item of value) if (isNode(item)) walkNode(item, enter);
        } else if (isNode(value)) {
            walkNode(value, enter);
        }
    }
    enter(node);
}

/** Calls `visitors[node.type]` for every matching node. */
export function simple<S = undefined>(node: AstNode, visitors: SimpleVisitors<S>, _base?: unknown, state?: S): void {
    walkNode(node as AnyNode, (n) => {
        const visit = visitors[n.type];
        if (visit) visit(n, state as S);
    });
}

/** Calls `callback` for every node, whatever its type. */
export function full<S = undefined>(node: AstNode, callback: Visitor<S>, _base?: unknown, state?: S): void {
    walkNode(node as AnyNode, (n) => callback(n, state as S));
}

export default { simple, full };
