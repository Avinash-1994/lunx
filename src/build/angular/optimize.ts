/**
 * Angular's build optimizations, as `ng build` runs them (Babel plugins from
 * @angular/build, MIT: Copyright Google LLC, https://angular.dev/license),
 * written against the Babel instance they are given, so they need nothing but
 * the @babel/core that @angular/compiler-cli already brings for its linker.
 *
 *  - markTopLevelPure: top-level calls and `new` in Angular packages are pure
 *    (only `new InjectionToken()` elsewhere), so unused ones tree-shake away.
 *  - adjustStaticMembers: a class with static members (`ɵcmp`, `ɵfac`, `ɵprov`…)
 *    goes in a pure IIFE, so an unused component, directive or service drops out.
 *  - elideAngularMetadata: `ɵsetClassMetadata` / `ɵsetClassDebugInfo` (for TestBed
 *    and dev tools) become `void 0`.
 *  - adjustTypeScriptEnums: TypeScript enums become pure IIFEs.
 *
 * Together they take a counter app from 82 kB to 32 kB of gzip JS, as `ng build`.
 */

type Babel = any;
type Path = any;

const PURE = '#__PURE__';
const isPureAnnotated = (node: any) => !!node.leadingComments?.some((c: any) => /[@#]__PURE__/.test(c.value));

function annotateAsPure(t: any, pathOrNode: any): void {
    const node = pathOrNode.node ?? pathOrNode;
    if (!isPureAnnotated(node)) t.addComment(node, 'leading', PURE);
}

// ── markTopLevelPure ─────────────────────────────────────────────────────────

/** tslib's helpers: emitted by TypeScript for their side effects. */
const TSLIB_HELPERS = new Set([
    '__extends', '__assign', '__rest', '__decorate', '__param', '__esDecorate', '__runInitializers', '__propKey',
    '__setFunctionName', '__metadata', '__awaiter', '__generator', '__exportStar', '__createBinding', '__values',
    '__read', '__spread', '__spreadArrays', '__spreadArray', '__await', '__asyncGenerator', '__asyncDelegator',
    '__asyncValues', '__makeTemplateObject', '__importStar', '__importDefault', '__classPrivateFieldGet',
    '__classPrivateFieldSet', '__classPrivateFieldIn', '__addDisposableResource', '__disposeResources',
    '__rewriteRelativeImportExtension',
]);
function isTslibHelperName(name: string): boolean {
    const parts = name.split('$');
    if (parts.length > 2 || (parts.length === 2 && isNaN(+parts[1]!))) return false;
    return TSLIB_HELPERS.has(parts[0]!);
}
const SIDE_EFFECT_FREE_CONSTRUCTORS = new Set(['InjectionToken']);

export function markTopLevelPure(babel: Babel) {
    const t = babel.types;
    return {
        visitor: {
            CallExpression(path: Path, state: any) {
                if (state.opts.topLevelSafeMode || path.getFunctionParent()) return;
                const callee = path.get('callee');
                if ((callee.isFunctionExpression() || callee.isArrowFunctionExpression()) && path.node.arguments.length !== 0) return;
                if (callee.isIdentifier() && (isTslibHelperName(callee.node.name) || callee.node.name === '_defineProperty')) return;
                annotateAsPure(t, path);
            },
            NewExpression(path: Path, state: any) {
                if (path.getFunctionParent()) return;
                if (!state.opts.topLevelSafeMode) return annotateAsPure(t, path);
                const callee = path.get('callee');
                if (callee.isIdentifier() && SIDE_EFFECT_FREE_CONSTRUCTORS.has(callee.node.name)) annotateAsPure(t, path);
            },
        },
    };
}

// ── elideAngularMetadata ─────────────────────────────────────────────────────

const isInlineFunction = (p: Path) => p.isFunctionExpression() || p.isArrowFunctionExpression();
const METADATA_CALLS: Record<string, (args: Path[]) => boolean> = {
    ɵsetClassMetadata: (a) => a.length === 4 && a[0].isIdentifier() && a[1].isArrayExpression(),
    ɵsetClassMetadataAsync: (a) => a.length === 3 && a[0].isIdentifier() && isInlineFunction(a[1]) && isInlineFunction(a[2]),
    ɵsetClassDebugInfo: (a) => a.length === 2 && a[0].isIdentifier() && a[1].isObjectExpression(),
};

export function elideAngularMetadata() {
    return {
        visitor: {
            CallExpression(path: Path) {
                const callee = path.get('callee');
                let name: string | undefined;
                if (callee.isMemberExpression()) {
                    const property = callee.get('property');
                    if (property.isIdentifier()) name = property.node.name;
                } else if (callee.isIdentifier()) name = callee.node.name;
                if (!name || !Object.hasOwn(METADATA_CALLS, name) || !METADATA_CALLS[name]!(path.get('arguments'))) return;
                // Always emitted inside a function expression; `void 0` is what the call returns.
                const parent = path.getFunctionParent();
                if (parent && (parent.isFunctionExpression() || parent.isArrowFunctionExpression())) path.replaceWith(path.scope.buildUndefinedNode());
            },
        },
    };
}

// ── adjustTypeScriptEnums ────────────────────────────────────────────────────

export function adjustTypeScriptEnums(babel: Babel) {
    const t = babel.types;
    return {
        visitor: {
            VariableDeclaration(path: Path) {
                const { parentPath, node } = path;
                if (node.kind !== 'var' || node.declarations.length !== 1) return;
                const declaration = path.get('declarations')[0];
                if (declaration.node.init) return;
                const id = declaration.node.id;
                if (!t.isIdentifier(id)) return;
                const origin = parentPath.isExportNamedDeclaration() || parentPath.isExportDefaultDeclaration() ? parentPath : path;
                const next = origin.getSibling(+(origin.key ?? 0) + 1);
                if (!next.isExpressionStatement()) return;
                const call = next.get('expression');
                if (!call.isCallExpression() || call.node.arguments.length !== 1) return;
                const arg = call.get('arguments')[0];
                if (!arg.isLogicalExpression({ operator: '||' })) return;
                const left = arg.get('left');
                const right = arg.get('right');
                if (!left.isIdentifier() || !call.scope.bindingIdentifierEquals(left.node.name, id) || !right.isAssignmentExpression()) return;
                const callee = call.get('callee');
                if (!callee.isFunctionExpression() || callee.node.params.length !== 1) return;
                const param = callee.get('params')[0];
                if (!param.isIdentifier()) return;
                let hasMembers = false;
                for (const statement of callee.get('body').get('body')) {
                    if (!statement.isExpressionStatement()) return;
                    const assignment = statement.get('expression');
                    if (!assignment.isAssignmentExpression() || !assignment.get('right').isPure()) return;
                    hasMembers = true;
                }
                if (!hasMembers) return;
                if (right.get('left').isIdentifier()) right.replaceWith(right.get('right'));
                callee.get('body').node.body.push(t.returnStatement(t.cloneNode(param.node)));
                const initializer = call.node;
                call.remove();
                annotateAsPure(t, initializer);
                declaration.get('init').replaceWith(initializer);
            },
        },
    };
}

// ── adjustStaticMembers ──────────────────────────────────────────────────────

const STATICS_TO_WRAP = new Set(['ɵcmp', 'ɵdir', 'ɵfac', 'ɵinj', 'ɵmod', 'ɵpipe', 'ɵprov', 'INJECTOR_KEY']);
const STATICS_TO_ELIDE: Record<string, (p: Path) => boolean> = {
    ctorParameters: (p) => p.isFunctionExpression() || p.isArrowFunctionExpression(),
    decorators: (p) => p.isArrayExpression(),
    propDecorators: (p) => p.isObjectExpression(),
};

function canWrapProperty(name: string, value: Path): boolean {
    if (STATICS_TO_WRAP.has(name)) return true;
    if (value.node.leadingComments?.some(({ value: c }: any) => c.includes('@__PURE__') || c.includes('#__PURE__') || c.includes('@pureOrBreakMyCode'))) return true;
    return value.isPure();
}

function analyzeClassSiblings(t: any, origin: Path, classId: any, allowWrappingDecorators: boolean) {
    const wrap: Path[] = [];
    let hasPotentialSideEffects = false;
    for (let i = 1; ; ++i) {
        const next = origin.getSibling(+(origin.key ?? 0) + i);
        if (!next.isExpressionStatement()) break;
        const expression = next.get('expression');
        if (expression.isCallExpression()) {
            if (!t.isIdentifier(expression.node.callee) || expression.node.callee.name !== '__decorate') break;
            if (allowWrappingDecorators) wrap.push(next);
            else hasPotentialSideEffects = true;
            continue;
        } else if (!expression.isAssignmentExpression()) break;
        const left = expression.get('left');
        if (left.isIdentifier()) {
            const r = expression.node.right;
            if (!left.scope.bindingIdentifierEquals(left.node.name, classId) || !t.isCallExpression(r) || !t.isIdentifier(r.callee) || r.callee.name !== '__decorate') break;
            if (allowWrappingDecorators) wrap.push(next);
            else hasPotentialSideEffects = true;
            continue;
        } else if (!left.isMemberExpression() || !t.isIdentifier(left.node.object) || !left.scope.bindingIdentifierEquals(left.node.object.name, classId) || !t.isIdentifier(left.node.property)) {
            break;
        }
        const name = left.node.property.name;
        const value = expression.get('right');
        if (STATICS_TO_ELIDE[name]?.(value)) {
            next.remove();
            --i;
        } else if (canWrapProperty(name, value)) wrap.push(next);
        else hasPotentialSideEffects = true;
    }
    return { hasPotentialSideEffects, wrap };
}

function shouldWrapStaticProperties(path: Path): boolean {
    let shouldWrap = false;
    for (const element of path.get('body').get('body')) {
        if (element.isClassProperty()) {
            if (!element.node.static) continue;
            const key = element.get('key');
            const value = element.get('value');
            if (key.isIdentifier() && (!value.isExpression() || canWrapProperty(key.node.name, value))) shouldWrap = true;
            else return false;
        } else if (element.isStaticBlock()) {
            const body = element.get('body');
            if (Array.isArray(body) && body.length > 1) return false;
            const assignment = body.find((n: Path) => n.isExpressionStatement())?.get('expression');
            if (assignment?.isAssignmentExpression()) {
                const left = assignment.get('left');
                if (!left.isMemberExpression()) continue;
                if (!left.get('object').isThisExpression()) return false;
                const property = left.get('property');
                const right = assignment.get('right');
                if (property.isIdentifier() && (!right.isExpression() || canWrapProperty(property.node.name, right))) shouldWrap = true;
                else return false;
            }
        }
    }
    return shouldWrap;
}

export function adjustStaticMembers(babel: Babel) {
    const t = babel.types;
    const visited = new WeakSet<object>();
    const exportDefaultAnalysis = new WeakMap<object, ReturnType<typeof analyzeClassSiblings>>();
    const pureIife = (body: any[]) => {
        const call = t.callExpression(t.parenthesizedExpression(t.arrowFunctionExpression([], t.blockStatement(body))), []);
        annotateAsPure(t, call);
        return call;
    };
    return {
        visitor: {
            // A class turned into a variable cannot stay an `export default` declaration: split it.
            ExportDefaultDeclaration(path: Path, state: any) {
                const declaration = path.get('declaration');
                if (!declaration.isClassDeclaration() || !declaration.node.id) return;
                const analysis = analyzeClassSiblings(t, path, declaration.node.id, !!state.opts.wrapDecorators);
                exportDefaultAnalysis.set(declaration.node, analysis);
                if (analysis.hasPotentialSideEffects) return;
                const id = declaration.node.id;
                path.insertAfter(t.exportNamedDeclaration(null, [t.exportSpecifier(t.cloneNode(id), t.identifier('default'))]));
                path.replaceWith(declaration.node);
            },
            ClassDeclaration(path: Path, state: any) {
                const { node, parentPath } = path;
                if (visited.has(node) || !node.id) return;
                const origin = parentPath.isExportNamedDeclaration() ? parentPath : path;
                const { wrap, hasPotentialSideEffects } = exportDefaultAnalysis.get(node) ?? analyzeClassSiblings(t, origin, node.id, !!state.opts.wrapDecorators);
                visited.add(node);
                if (hasPotentialSideEffects || (wrap.length === 0 && !shouldWrapStaticProperties(path))) return;
                const statements = wrap.map((p) => {
                    const n = p.node;
                    p.remove();
                    return n;
                });
                const init = pureIife([node, ...statements, t.returnStatement(t.cloneNode(node.id))]);
                path.replaceWith(t.variableDeclaration('let', [t.variableDeclarator(t.cloneNode(node.id), init)]));
            },
            ClassExpression(path: Path, state: any) {
                const { node, parentPath } = path;
                if (visited.has(node)) return;
                if (!parentPath.isVariableDeclarator() || !t.isIdentifier(parentPath.node.id)) return;
                const origin = parentPath.parentPath;
                if (!origin.isVariableDeclaration() || origin.node.declarations.length !== 1) return;
                const { wrap, hasPotentialSideEffects } = analyzeClassSiblings(t, origin, parentPath.node.id, !!state.opts.wrapDecorators);
                visited.add(node);
                if (hasPotentialSideEffects || (wrap.length === 0 && !shouldWrapStaticProperties(path))) return;
                const statements = wrap.map((p) => {
                    const n = p.node;
                    p.remove();
                    return n;
                });
                parentPath.get('init').replaceWith(pureIife([
                    t.variableDeclaration('let', [t.variableDeclarator(t.cloneNode(parentPath.node.id), node)]),
                    ...statements,
                    t.returnStatement(t.cloneNode(parentPath.node.id)),
                ]));
            },
        },
    };
}
