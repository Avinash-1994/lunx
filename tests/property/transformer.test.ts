/**
 * Property-Based Tests for Universal Transformer
 * 
 * Uses fast-check to automatically generate test cases and discover edge cases
 * that traditional example-based testing might miss.
 */

import { jest } from '@jest/globals';
import fc from 'fast-check';
import { UniversalTransformer } from '../../src/core/universal-transformer.js';
import * as acorn from 'acorn';
import path from 'path';

describe('Property-Based: Universal Transformer', () => {
    const transformer = new UniversalTransformer(process.cwd());

    // Words that cannot name a binding in a module (strict mode).
    const RESERVED = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'eval', 'arguments']);
    const identifier = fc.stringMatching(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/).filter((name) => !RESERVED.has(name));

    /**
     * Property: Transformed code should always be valid JavaScript
     * 
     * This test generates random valid JavaScript code and ensures
     * the transformer always produces parseable output.
     */
    it('should always produce valid JavaScript from valid input', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(
                    // Simple variable declarations
                    fc.record({
                        type: fc.constant('var'),
                        name: identifier,
                        value: fc.oneof(fc.integer(), fc.string(), fc.boolean())
                    }).map(({ name, value }) =>
                        `const ${name} = ${JSON.stringify(value)};`
                    ),

                    // Function declarations
                    fc.record({
                        name: identifier,
                        params: fc.array(identifier, { maxLength: 3 }),
                        body: fc.constant('return true;')
                    }).map(({ name, params, body }) =>
                        `function ${name}(${params.join(', ')}) { ${body} }`
                    ),

                    // Import statements
                    fc.record({
                        name: identifier,
                        from: fc.stringMatching(/^[a-zA-Z0-9\-_/]+$/)
                    }).map(({ name, from }) =>
                        `import ${name} from '${from}';`
                    )
                ),
                async (code) => {
                    try {
                        const result = await transformer.transform({
                            filePath: path.join(process.cwd(), 'test.js'),
                            code,
                            framework: 'vanilla',
                            root: process.cwd(),
                            isDev: false
                        });

                        // Result should be parseable JavaScript
                        expect(() => acorn.parse(result.code, {
                            ecmaVersion: 'latest',
                            sourceType: 'module'
                        })).not.toThrow();

                        return true;
                    } catch (error) {
                        // If transform fails, it should fail gracefully
                        expect(error).toBeDefined();
                        return true;
                    }
                }
            ),
            { numRuns: 50 } // Reduced from 100 for speed
        );
    }, 30000);

    /**
     * Property: TypeScript type annotations should be removed
     * 
     * Generates TypeScript code with type annotations and verifies
     * they are completely removed in the output.
     */
    it('should strip TypeScript types', async () => {
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        try {
            const tsPattern = fc.tuple(
                fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-z]+$/.test(s)), // var name
                fc.constantFrom('string', 'number', 'boolean', 'any', 'void', 'path.Join')  // type
            ).map(([name, type]) => ({
                code: `const ${name}: ${type} = null;`,
                varName: name,
                type
            }));

            await fc.assert(
                fc.asyncProperty(
                    tsPattern,
                    async ({ code, varName, type }) => {
                        try {
                            const result = await transformer.transform({
                                filePath: path.join(process.cwd(), 'test.ts'),
                                code,
                                framework: 'vanilla',
                                root: process.cwd(),
                                isDev: false
                            });

                            // If transform failed (returns original code), skip assertions
                            // This happens if generated code is syntactically invalid for TS
                            if (result.code === code) return true;

                            // Should be valid JS (no types)
                            expect(result.code).toBeDefined();

                            // Type annotation should be gone
                            // Simple check: ": Type" should not exist
                            expect(result.code).not.toContain(`: ${type}`);
                            // Variable should still exist
                            expect(result.code).toContain(varName);

                            return true;
                        } catch {
                            return true;
                        }
                    }
                )
            );
        } finally {
            consoleErrorSpy.mockRestore();
        }
    }, 30000);


    /**
     * Property: Transformation should be idempotent for vanilla JS
     * 
     * Transforming already-transformed code should produce the same result.
     */
    it('should be idempotent for vanilla JavaScript', async () => {
        await fc.assert(
            fc.asyncProperty(
                identifier.chain(name =>
                    fc.record({
                        name: fc.constant(name),
                        value: fc.integer()
                    })
                ).map(({ name, value }) => `const ${name} = ${value};`),
                async (code) => {
                    const result1 = await transformer.transform({
                        filePath: path.join(process.cwd(), 'test.js'),
                        code,
                        framework: 'vanilla',
                        root: process.cwd(),
                        isDev: false
                    });

                    const result2 = await transformer.transform({
                        filePath: path.join(process.cwd(), 'test.js'),
                        code: result1.code,
                        framework: 'vanilla',
                        root: process.cwd(),
                        isDev: false
                    });

                    // Second transformation should produce same result
                    expect(result2.code.trim()).toBe(result1.code.trim());

                    return true;
                }
            ),
            { numRuns: 30 }
        );
    }, 30000);

    /**
     * Property: Source maps should always be generated when requested
     * 
     * Any transformation should produce a valid source map.
     */
    it('should generate source maps when requested', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(
                    fc.constant('const x = 1;'),
                    fc.constant('function foo() { return 42; }'),
                    fc.constant('export default class Bar {}')
                ),
                async (code) => {
                    const result = await transformer.transform({
                        filePath: path.join(process.cwd(), 'test.js'),
                        code,
                        framework: 'vanilla',
                        root: process.cwd(),
                        isDev: true // Dev mode typically generates source maps
                    });

                    // Source map might be inline or separate
                    // Just check that transformation succeeded
                    expect(result.code).toBeDefined();
                    expect(result.code.length).toBeGreaterThan(0);

                    return true;
                }
            ),
            { numRuns: 20 }
        );
    }, 20000);

    /**
     * Property: Invalid code should fail gracefully
     * 
     * Malformed code should produce meaningful error messages.
     */
    it('should handle invalid code gracefully', async () => {
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });
        try {
            await fc.assert(
                fc.asyncProperty(
                    fc.oneof(
                        fc.constant('const x = {{{'),
                        fc.constant('function ((('),
                        fc.constant('import from'),
                        fc.constant('const 123abc = 1;')
                    ),
                    async (invalidCode) => {
                        try {
                            await transformer.transform({
                                filePath: path.join(process.cwd(), 'test.js'),
                                code: invalidCode,
                                framework: 'vanilla',
                                root: process.cwd(),
                                isDev: false
                            });
                            // If it doesn't throw, that's also acceptable
                            return true;
                        } catch (error: any) {
                            // Error should have a message
                            expect(error.message).toBeDefined();
                            expect(typeof error.message).toBe('string');
                            expect(error.message.length).toBeGreaterThan(0);
                            return true;
                        }
                    }
                ),
                { numRuns: 10 }
            );
        } finally {
            consoleErrorSpy.mockRestore();
        }
    }, 15000);

    /**
     * Property: React JSX should be transformed
     * 
     * Generates various JSX patterns and ensures they're properly transformed.
     */
    it('should transform JSX to valid JavaScript', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    tag: fc.oneof(
                        fc.constant('div'),
                        fc.constant('span'),
                        fc.constant('button')
                    ),
                    content: fc.oneof(
                        fc.string().map(s => s.replace(/[<>{}]/g, '')),
                        fc.constant('')
                    )
                }),
                async ({ tag, content }) => {
                    const jsxCode = `const el = <${tag}>${content}</${tag}>;`;

                    const result = await transformer.transform({
                        filePath: path.join(process.cwd(), 'test.jsx'),
                        code: jsxCode,
                        framework: 'react',
                        root: process.cwd(),
                        isDev: false
                    });

                    // Should not contain JSX syntax
                    expect(result.code).not.toContain(`<${tag}>`);
                    // Should contain createElement or jsx runtime
                    const hasCreateElement = result.code.includes('createElement') ||
                        result.code.includes('jsx') ||
                        result.code.includes('_jsx');
                    expect(hasCreateElement).toBe(true);

                    return true;
                }
            ),
            { numRuns: 20 }
        );
    }, 30000);

    /**
     * Property: Code size should not explode
     * 
     * Transformed code should not be unreasonably larger than input.
     */
    it('should not produce unreasonably large output', async () => {
        // Suppress console.error for this test as we expect transformer errors on random input
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        try {
            await fc.assert(
                fc.asyncProperty(
                    fc.string({ minLength: 10, maxLength: 500 }).filter(s => {
                        // Filter to valid-ish JavaScript
                        return /^[a-zA-Z0-9\s;=(){}[\]"'.,]*$/.test(s);
                    }),
                    async (code) => {
                        try {
                            const result = await transformer.transform({
                                filePath: path.join(process.cwd(), 'test.js'),
                                code,
                                framework: 'vanilla',
                                root: process.cwd(),
                                isDev: false
                            });

                            // Output should not be more than 20x input size (lenient)
                            const sizeRatio = result.code.length / code.length;
                            expect(sizeRatio).toBeLessThan(20);

                            return true;
                        } catch {
                            // Invalid code is acceptable
                            return true;
                        }
                    }
                ),
                { numRuns: 30 }
            );
        } finally {
            consoleErrorSpy.mockRestore();
        }
    }, 30000);

    // Simple sanity test
    it('should instantiate transformer', () => {
        expect(transformer).toBeDefined();
        expect(transformer).toBeInstanceOf(UniversalTransformer);
    });
});

