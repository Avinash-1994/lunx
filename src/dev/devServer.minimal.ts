/**
 * Minimal Dev Server - <50ms Cold Start Target
 * 
 * Strategy: Start HTTP server IMMEDIATELY, serve shell fast, load engine in background
 */

import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { BuildConfig } from '../config/index.js';
import { createRequire } from 'module';
import { displayHost, isPortFree, resolveBindHost } from '../utils/host.js';

const require = createRequire(import.meta.url);
const pkgVersion = require('../../package.json').version;

/** FEAT-CLI-02: surfaced to the CLI dev handler for the startup banner */
export let detectedAdapter: string | null = null;

export async function startDevServer(cfg: BuildConfig) {
    let features: any = null;
    let initPromise: Promise<void> | null = null;
    const startTime = performance.now();
    const root = cfg.root || process.cwd();

    // 1. Find available port FIRST (before creating server)
    let port = cfg.server?.port || cfg.port || 5173;
    // Dual-stack `::` where the host supports IPv6, `0.0.0.0` where it does not.
    const host = await resolveBindHost(cfg.server?.host);

    // Find available port
    if (!cfg.server?.strictPort) {
        while (!(await isPortFree(port, host))) {
            console.log(`\x1b[33m⚠\x1b[0m  Port ${port} is in use, trying ${port + 1}...`);
            port++;
            if (port > (cfg.server?.port || cfg.port || 5173) + 100) {
                throw new Error('Could not find an available port');
            }
        }
    }

    // Update config with confirmed port
    if (!cfg.server) cfg.server = {};
    cfg.server.port = port;
    cfg.port = port;

    // Resolved by the full dev server as soon as its request handler exists.
    let markHandlerReady!: () => void;
    const handlerReady = new Promise<void>((resolve) => (markHandlerReady = resolve));
    const startInit = () => {
        initPromise ??= (async () => {
            const { startDevServer: initFull } = await import('./devServer.js');
            features = await initFull(cfg, server);
        })();
        return initPromise;
    };

    // 2. Create hyper-responsive HTTP server
    const server: http.Server = http.createServer(async (req, res) => {
        if (features && (server as any).__lunx_handler) {
            return (server as any).__lunx_handler(req, res);
        }

        const url = req.url || '/';
        const [pathname] = url.split('?');

        startInit();

        // Every request, HTML included, waits for the real pipeline.
        // Serving index.html straight off disk used to skip the dev server's
        // HTML transforms -- the HMR client and the React Refresh preamble
        // among them -- so the very first page load of a cold start died with
        // "$RefreshReg$ is not defined" and never recovered. Waiting only for
        // the request handler (not watchers etc.) keeps that and saves ~250ms.
        await Promise.race([initPromise, handlerReady]);
        if ((server as any).__lunx_handler) {
            return (server as any).__lunx_handler(req, res);
        }

        // Immediate Splash Fallback
        res.writeHead(200, { 'Content-Type': 'text/html', 'Connection': 'close' });
        res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0.1"/><style>body{background:#0d1117;color:#c9d1d9;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;font-family:system-ui}h1{color:#58a6ff;margin-bottom:8px}.loader{width:40px;height:40px;border:3px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:s 0.6s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head><body><div class="loader"></div><h1>Lunx</h1><p>Igniting engine...</p></body></html>`);
    });

    // 3. Bind to the confirmed available port
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, async () => {
            // Start the full pipeline first; the banner below can wait.
            (server as any).__lunx_onHandler = markHandlerReady;
            startInit().catch(() => {});
            const duration = (performance.now() - startTime).toFixed(2);

            // Get network IP
            const networkInterfaces = os.networkInterfaces();
            let networkIP = '';
            for (const name of Object.keys(networkInterfaces)) {
                const ifaces = networkInterfaces[name];
                if (!ifaces) continue;
                for (const iface of ifaces) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        networkIP = iface.address;
                        break;
                    }
                }
                if (networkIP) break;
            }

            // Enhanced Startup Banner (Create React App style)
            console.log(`\n\x1b[32mStarting the development server...\x1b[0m\n`);

            // Futuristic Lunx Branding (Engineering First)
            console.log(`\x1b[36m   ⚡ LUNX \x1b[90mv${pkgVersion}\x1b[0m`);
            console.log(`\x1b[90m   ─────────────────────────────────────\x1b[0m`);

            // Metrics Layout
            console.log(`   \x1b[32m▶\x1b[0m  \x1b[1mCore\x1b[0m    \x1b[32mReady\x1b[0m in \x1b[33m${duration}ms\x1b[0m`);
            // Report the engine actually loaded, not a fixed string: a bug
            // report from the JS fallback must not look like one from native.
            let engine = 'Oxc (JS helpers)';
            try {
                const native = await import('../native/index.js');
                if ((native as any).engineUsed === 'native') engine = 'Rust native';
            } catch { /* JS fallback */ }
            console.log(`   \x1b[34m▶\x1b[0m  \x1b[1mEngine\x1b[0m  \x1b[90m${engine}\x1b[0m`);
            console.log(`   \x1b[35m▶\x1b[0m  \x1b[1mBundler\x1b[0m \x1b[90mRolldown (production builds)\x1b[0m`);

            console.log(`\x1b[90m   ─────────────────────────────────────\x1b[0m`);

            // Links - show localhost for local access, actual network IP for network access
            const localHost = displayHost(host);
            console.log(`   \x1b[1mLocal\x1b[0m    \x1b[36mhttp://${localHost}:${port}/\x1b[0m`);
            if (networkIP) {
                console.log(`   \x1b[1mNetwork\x1b[0m  \x1b[36mhttp://${networkIP}:${port}/\x1b[0m`);
            }
            console.log(`\x1b[90m   ─────────────────────────────────────\x1b[0m`);

            // Helpful tips
            console.log(`\n\x1b[90mNote that the development build is not optimized.\x1b[0m`);
            console.log(`\x1b[90mTo create a production build, use \x1b[36mnpm run build\x1b[0m\x1b[90m.\x1b[0m\n`);

            // Detect adapter for startup banner (FIX-1: use priority map directly)
            try {
                const fsSync = (await import('fs')).default;
                const pathMod = (await import('path')).default;
                const rootDir = cfg.root || process.cwd();
                let pkg: Record<string, any> = {};
                try {
                    pkg = JSON.parse(fsSync.readFileSync(pathMod.join(rootDir, 'package.json'), 'utf-8'));
                } catch (e) {}
                const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
                const PRIORITY = [
                    { dep: '@sveltejs/kit',        name: 'svelte-kit'     },
                    { dep: 'nuxt',                 name: 'nuxt'           },
                    { dep: '@solidjs/start',        name: 'solid-start'    },
                    { dep: '@builder.io/qwik-city', name: 'qwik-city'     },
                    { dep: '@angular/core',         name: 'angular'        },
                    { dep: '@analogjs/platform',    name: 'analog'         },
                    { dep: '@remix-run/dev',        name: 'remix'          },
                    { dep: '@tanstack/start',       name: 'tanstack-start' },
                    { dep: 'react-router',          name: 'react-router'   },
                    { dep: 'waku',                  name: 'waku'           },
                    { dep: 'vitepress',             name: 'vitepress'      },
                    { dep: 'astro',                 name: 'astro'          },
                    { dep: 'next',                  name: 'next'           },
                    { dep: 'nuxt',                  name: 'nuxt'           },
                    { dep: 'gatsby',                name: 'gatsby'         },
                    { dep: 'react',                 name: 'react'          },
                    { dep: 'vue',                   name: 'vue'            },
                    { dep: 'svelte',                name: 'svelte'         },
                ];
                const found = PRIORITY.find(({ dep }) => dep in allDeps);
                detectedAdapter = found?.name ?? 'none';
            } catch { detectedAdapter = null; }


            resolve();
        });
    });

    return server;
}
