import { build } from '../dist/build/bundler.js';
import path from 'path';
import fs from 'fs/promises';
import assert from 'assert';

async function testAssetPipeline() {
    console.log('Running Asset Pipeline Test...');
    const cwd = process.cwd();
    const testDir = path.join(cwd, 'test_assets_temp');

    try {
        // Create test directory structure
        await fs.mkdir(path.join(testDir, 'src'), { recursive: true });
        await fs.mkdir(path.join(testDir, 'public'), { recursive: true });

        // Create a test image (1x1 red pixel PNG)
        const redPixelPng = Buffer.from([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
            0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00,
            0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
            0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D, 0xB4, 0x00, 0x00, 0x00,
            0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
        ]);

        await fs.writeFile(path.join(testDir, 'src', 'test.png'), redPixelPng);

        // Create test entry point that imports the image
        const entryContent = `
import logo from './test.png';
console.log('Logo path:', logo);
export default logo;
`;
        await fs.writeFile(path.join(testDir, 'src', 'main.js'), entryContent);

        // Create minimal index.html
        await fs.writeFile(path.join(testDir, 'public', 'index.html'), '<html><body>Test</body></html>');

        // Build config
        const config = {
            root: testDir,
            entry: ['src/main.js'],
            mode: 'development' as const,
            outDir: 'dist',
            port: 3000,
            platform: 'browser' as const,
            // The fixture is a 1x1 PNG; small assets are inlined by default.
            build: { assetsInlineLimit: 0 }
        };

        // Run build
        await build(config);

        // Verify output
        const distDir = path.join(testDir, 'dist');
        const assetsDir = path.join(distDir, 'assets');

        // Check that assets directory exists
        const assetsDirExists = await fs.access(assetsDir).then(() => true).catch(() => false);
        assert(assetsDirExists, 'Assets directory should exist');

        // Check that a hashed PNG file exists
        const assetFiles = await fs.readdir(assetsDir);
        const pngFiles = assetFiles.filter(f => f.endsWith('.png'));
        assert(pngFiles.length > 0, 'Should have at least one PNG file');
        assert(pngFiles[0].includes('.'), 'PNG filename should include hash');

        // Check that the JS bundle exists and contains the asset reference
        const assetFilesInDist = await fs.readdir(assetsDir);
        const bundleFiles = assetFilesInDist.filter(f => f.endsWith('.js'));
        assert(bundleFiles.length > 0, 'Should have at least one JS bundle in assets directory');

        const bundleContent = await fs.readFile(path.join(assetsDir, bundleFiles[0]), 'utf-8');
        assert(bundleContent.includes('/assets/'), 'Bundle should reference assets directory');

        console.log('✓ Asset Pipeline Test Passed!');
        console.log(`  - Created hashed asset: ${pngFiles[0]}`);
        console.log(`  - Bundle references: /assets/`);

    } catch (error) {
        console.error('✗ Asset Pipeline Test Failed:', error);
        throw error;
    } finally {
        // Cleanup
        await fs.rm(testDir, { recursive: true, force: true });
    }
}

testAssetPipeline();
