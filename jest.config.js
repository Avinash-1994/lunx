export default {
    preset: 'ts-jest/presets/default-esm', // Use ESM preset
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts', '.mts'],
    testMatch: [
        '<rootDir>/tests/**/*.test.ts',
        '<rootDir>/src/**/*.test.ts'
    ],
    testPathIgnorePatterns: [
        '/node_modules/',
        '/tests/e2e/',
        '/tests/fixtures/',  // Ignore all fixture test files
        '/tests/visual/',  // Visual tests use Playwright, not Jest
        '/tests/module7_.*\\.test\\.ts$'  // These use custom Lunx test API, not Jest
    ],
    roots: ['<rootDir>/tests', '<rootDir>/src'], // Run tests in both directories
    transform: {
        '^.+\\.m?[tj]sx?$': ['ts-jest', {
            useESM: true,
            tsconfig: {
                module: 'esnext',
                target: 'es2020',
                esModuleInterop: true,
                moduleResolution: 'bundler'
            }
        }],
    },
    moduleNameMapper: {
        // Map native binding imports to our CJS shim (must be before the .js stripper)
        '^.*[/\\\\]native[/\\\\]index(\\.js)?$': '<rootDir>/native/index.cjs',
        '^(\\.\\.?/.*)\\.js$': '$1',  // Fixed: matches ./ and ../ imports
    },
    // Don't transform native CJS files or binary .node files
    transformIgnorePatterns: [
        '/node_modules/',
        '\\.node$',
        '/native/index\\.cjs$',
        '<rootDir>/dist/',  // already compiled ES modules
    ],
    collectCoverageFrom: [
        'src/**/*.{ts,tsx}',
        '!src/**/*.d.ts',
        '!src/cli/**',
    ],
    // Silence Node.js ExperimentalWarning: VM Modules — it's expected with --experimental-vm-modules
    testEnvironmentOptions: {
        customExportConditions: ['node', 'node-addons'],
    },
    globals: {
        'ts-jest': {
            diagnostics: false, // suppress ts-jest noise during tests
        },
    },
};
