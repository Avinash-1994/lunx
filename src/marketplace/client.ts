
/**
 * Lunx Marketplace CLI Client
 * Implementation: tRPC Direct Caller (Simulates HTTP Client for Local MVP)
 * Day 10: Marketplace MVP Lock
 */

import { appRouter, createContext } from './server.js';
import { PluginSigner, PluginManifest } from '../plugins/signer.js';
import * as fs from 'fs';
import * as path from 'path';
import { green, red, blue, yellow, bold } from '../internal/colors.js';

// Create a caller for local execution (CLI -> Local DB)
const caller = appRouter.createCaller(createContext());

export class MarketplaceClient {

    /**
     * Publish a plugin file to the local registry
     */
    static async publish(wasmPath: string, meta: any) {
        console.log(blue(`\n📦 Publishing ${bold(meta.name)}...`));

        // 1. Read Binary
        const wasmBytes = fs.readFileSync(wasmPath);

        // 2. Generate Emphemeral Key for MVP (In real usage, load user's key)
        // For Day 10 demo, we generate a fresh key to prove signing works on publish
        const keyPair = await PluginSigner.generateKeyPair();

        // 3. Create Signed Manifest
        const manifest = await PluginSigner.createManifest(meta, wasmBytes, keyPair);

        // 4. Call Server
        try {
            const result = await caller.publish({
                manifest,
                wasmBase64: wasmBytes.toString('base64')
            });
            console.log(green(`✅ Success: ${result.message}`));
        } catch (e: any) {
            console.error(red(`❌ Publish Failed: ${e.message}`));
            throw e;
        }
    }

    /**
     * Search for plugins
     */
    static async search(query: string) {
        console.log(blue(`\n🔍 Searching for "${bold(query)}"...`));
        const results = await caller.search(query);
        console.table(results);
        return results;
    }

    /**
     * Install a plugin
     */
    static async install(name: string, installDir: string, version?: string) {
        console.log(blue(`\n⬇️  Installing ${bold(name)}${version ? `@${version}` : ''}...`));
        try {
            const plugin = await caller.install({ name, version });
            if (!plugin.artifactBase64) {
                throw new Error('Received plugin metadata without artifact payload');
            }

            console.log(green(`✅ Found ${bold(plugin.name)} v${plugin.version}`));
            console.log(yellow(`   Author: ${plugin.author}`));
            console.log(yellow(`   Permissions: ${plugin.permissions_json}`));

            const outputDir = path.resolve(installDir, plugin.name);
            fs.mkdirSync(outputDir, { recursive: true });

            const artifact = Buffer.from(plugin.artifactBase64, 'base64');
            const artifactPath = path.join(outputDir, `plugin-${plugin.version}.wasm`);
            fs.writeFileSync(artifactPath, artifact);

            const manifestPath = path.join(outputDir, 'plugin-manifest.json');
            fs.writeFileSync(manifestPath, JSON.stringify({
                name: plugin.name,
                version: plugin.version,
                author: plugin.author,
                description: plugin.description,
                permissions: JSON.parse(plugin.permissions_json || '{}')
            }, null, 2));

            console.log(green(`✅ Installed to ${outputDir}`));
            console.log(green(`   Artifact: ${artifactPath}`));
            return outputDir;

        } catch (e: any) {
            console.error(red(`❌ Install Failed: ${e.message}`));
            throw e;
        }
    }

    static async listVersions(name: string) {
        console.log(blue(`\n📄 Listing versions for ${bold(name)}...`));
        const results = await caller.versions(name);
        console.table(results);
        return results;
    }
}
