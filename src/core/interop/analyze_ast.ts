
import { ExportMap } from './types.js';
import { parse as parseModule } from '../../lib/oxc.js';

// Phase A: AST-Based Export Analysis

/**
 * Uses Acorn (ESTree) to analyze exports precisely.
 * 
 * Capability Matrix:
 * - ESM: export const, export default, export {}, export * 
 * - CJS: module.exports =, exports.foo =, Object.defineProperty(exports)
 */
export function analyzeExportsAST(content: string, format: 'esm' | 'cjs'): ExportMap {
    const exports: ExportMap = {
        named: new Set(),
        hasDefault: false,
        isDynamic: false,
        liveBindings: false,
        reexports: {}
    };

    try {
        // ESTree AST from Oxc
        // We use sourceType: 'module' for ESM, 'script' for CJS (though commonjs is looser)
        const ast = parseModule('module.js', content, 'js', format === 'esm' ? 'module' : 'script');

        if (format === 'esm') {
            walkESM(ast, exports);
        } else {
            walkCJS(ast, exports);
        }

    } catch (e: any) {
        // Fallback or error?
        // For interop, syntax error means module is broken anyway.
        // We might fallback to regex or simple detection if it's strange syntax (e.g. flow)
        // console.warn('AST Parse failed, module might rely on unknown syntax', e.message);
        // We leave map empty -> dynamic
        exports.isDynamic = true;
    }

    return exports;
}

function walkESM(ast: any, map: ExportMap) {
    for (const node of ast.body) {
        if (node.type === 'ExportDefaultDeclaration') {
            map.hasDefault = true;
        }
        else if (node.type === 'ExportNamedDeclaration') {
            if (node.declaration) {
                // export const foo = ...
                if (node.declaration.declarations) {
                    for (const decl of node.declaration.declarations) {
                        if (decl.id.type === 'Identifier') {
                            map.named.add(decl.id.name);
                            if (node.declaration.kind !== 'const') map.liveBindings = true;
                        }
                    }
                }
                // export function foo() {}
                else if (node.declaration.id) {
                    map.named.add(node.declaration.id.name);
                }
            }
            if (node.specifiers) {
                // export { foo, bar }
                for (const spec of node.specifiers) {
                    const exportedName = spec.exported.name;
                    map.named.add(exportedName);
                    // Identifying if local binding is mutable requires scope analysis.
                    // Assume 'live' for safety if re-exporting locals?
                    // Actually specifiers map local->export.
                    // For now, assume safe.
                    map.liveBindings = true; // export {} likely means re-export or live binding
                }
            }
            if (node.source) {
                // export { foo } from 'bar'
                // This is a re-export
                // We track it as named? Yes.
                // Also track re-export source
                // map.reexports[...] = ...
            }
        }
        else if (node.type === 'ExportAllDeclaration') {
            // export * from 'foo'
            map.isDynamic = true;
            if (node.source && node.source.value) {
                map.reexports['*'] = node.source.value;
            }
        }
    }
}

function walkCJS(ast: any, map: ExportMap) {
    // Simple walker for generic CJS patterns at top level
    // In CJS, assignments can be nested. A full walk is needed.
    // For MVP/Phase A, we walk specific top-level statements or block statements.

    // We'll implemented a tiny recursive walker since Acorn output is tree
    const visit = (node: any) => {
        if (!node) return;

        // Detect: module.exports = ...
        if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression') {
            const left = node.expression.left;
            // module.exports = ...
            if (left.type === 'MemberExpression' &&
                left.object.name === 'module' &&
                left.property.name === 'exports') {
                map.hasDefault = true;
                // If right side is object literal, extract keys?
                if (node.expression.right.type === 'ObjectExpression') {
                    node.expression.right.properties.forEach((p: any) => {
                        if (p.key.name) map.named.add(p.key.name);
                    });
                } else {
                    // assigning function or dynamic var
                    // treat as default, but potentially dynamic named?
                    // CJS often does module.exports = function() {}; module.exports.foo = ...
                    // So we must continue scanning.
                }
            }
            // exports.foo = ...
            else if (left.type === 'MemberExpression' &&
                left.object.name === 'exports') {
                if (left.property.name) map.named.add(left.property.name);
            }
            // module.exports.foo = ...
            else if (left.type === 'MemberExpression' &&
                left.object.type === 'MemberExpression' &&
                left.object.object.name === 'module' &&
                left.object.property.name === 'exports') {
                if (left.property.name) map.named.add(left.property.name);
            }
        }

        // Detect: Object.defineProperty(exports, 'foo', ...)
        if (node.type === 'ExpressionStatement' &&
            node.expression.type === 'CallExpression') {
            const callee = node.expression.callee;
            if (callee.type === 'MemberExpression' &&
                callee.object.name === 'Object' &&
                callee.property.name === 'defineProperty') {
                const args = node.expression.arguments;
                if (args.length >= 3) {
                    const target = args[0].name; // exports
                    const prop = args[1].value; // 'foo'
                    const desc = args[2];

                    if ((target === 'exports' || target === 'module.exports') && prop) {
                        map.named.add(prop);
                        // Check for getter
                        const hasGetter = desc.properties?.some((p: any) => p.key.name === 'get');
                        if (hasGetter) map.liveBindings = true;
                    }
                }
            }

            // Detect: require(...)
            if (callee.name === 'require') {
                map.isDynamic = true;
            }
        }

        // Recurse
        if (node.body) {
            if (Array.isArray(node.body)) node.body.forEach(visit);
            else visit(node.body);
        }
    };

    ast.body.forEach(visit);
}
