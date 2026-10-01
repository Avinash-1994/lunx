/**
 * Builder Server - WebSocket + REST API
 * Serves the Visual Builder UI and provides real-time config sync
 */

import http from 'http';
import { WebSocketServer } from '../internal/ws.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { watch } from 'fs';
import { loadConfig, saveConfig } from '../config/index.js';
import { analyzeProject, generateSuggestions } from '../ai/analyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BuilderServerConfig {
    port: number;
    root: string;
}

export async function startBuilderServer(config: BuilderServerConfig) {
    const { port, root } = config;

    // Create HTTP server
    const server = http.createServer(async (req, res) => {
        const url = req.url || '/';

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        // API Routes
        if (url.startsWith('/api/')) {
            await handleAPI(req, res, url, root);
            return;
        }

        // Serve builder UI
        await serveBuilderUI(req, res, url);
    });

    // Create WebSocket server
    const wss = new WebSocketServer({ server });
    const clients = new Set<any>();

    wss.on('connection', (ws) => {
        clients.add(ws);
        // log.debug('[builder] Client connected');

        ws.on('close', () => {
            clients.delete(ws);
            // log.debug('[builder] Client disconnected');
        });

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                await handleWebSocketMessage(message, ws, root);
            } catch (error) {
                console.error('[builder] WebSocket error:', error);
            }
        });
    });

    // Watch config file for changes
    watchConfigFile(root, (config) => {
        broadcast(clients, { type: 'config_update', config });
    });

    server.listen(port, () => {
        console.log(`\n🎨 Visual Builder running at http://localhost:${port}\n`);
    });

    return server;
}

// ===== API Handlers =====
async function handleAPI(req: http.IncomingMessage, res: http.ServerResponse, url: string, root: string) {
    const path = url.replace('/api', '');

    try {
        // GET /api/config
        if (path === '/config' && req.method === 'GET') {
            const config = await loadConfig(root);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
            return;
        }

        // POST /api/config
        if (path === '/config' && req.method === 'POST') {
            const body = await getBody(req);
            const config = JSON.parse(body);
            await saveConfig(root, config);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        // GET /api/suggestions
        if (path === '/suggestions' && req.method === 'GET') {
            const analysis = await analyzeProject(root);
            const suggestions = await generateSuggestions(analysis);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(suggestions));
            return;
        }

        // GET /api/plugins
        if (path === '/plugins' && req.method === 'GET') {
            const plugins = await getAvailablePlugins();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(plugins));
            return;
        }

        // GET /api/metrics
        if (path === '/metrics' && req.method === 'GET') {
            const metrics = await getBuildMetrics(root);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(metrics));
            return;
        }

        // GET /__open-in-editor
        if (path.startsWith('/__open-in-editor') && req.method === 'GET') {
            const urlObj = new URL(req.url || '', `http://${req.headers.host}`);
            const file = urlObj.searchParams.get('file');
            const line = parseInt(urlObj.searchParams.get('line') || '1');
            const column = parseInt(urlObj.searchParams.get('column') || '1');

            if (file) {
                const { openInEditor } = await import('../internal/open-editor.js');
                openInEditor(file, line, column);
                res.writeHead(200);
                res.end('Opened in editor');
            } else {
                res.writeHead(400);
                res.end('Missing file parameter');
            }
            return;
        }

        // 404
        res.writeHead(404);
        res.end('Not found');
    } catch (error: any) {
        console.error('[builder] API error:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
    }
}

export function broadcastError(clients: Set<any>, error: any) {
    const message = {
        type: 'error',
        error: {
            message: error.message || String(error),
            stack: error.stack,
            filename: error.filename,
            lineno: error.lineno,
            colno: error.colno,
            frame: error.frame
        }
    };
    broadcast(clients, message);
}

// ===== Builder UI Server =====
async function serveBuilderUI(req: http.IncomingMessage, res: http.ServerResponse, url: string) {
    let filePath: string;

    if (url === '/' || url === '/index.html') {
        filePath = path.join(process.cwd(), 'public', 'builder', 'index.html');
    } else if (url.startsWith('/builder/')) {
        filePath = path.join(process.cwd(), 'public', url);
    } else {
        filePath = path.join(process.cwd(), 'public', 'builder', url);
    }

    try {
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath);
        const mimeTypes: Record<string, string> = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.svg': 'image/svg+xml'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    } catch (error) {
        // Serve index.html for SPA routes
        try {
            const indexPath = path.join(process.cwd(), 'public', 'builder', 'index.html');
            const data = await fs.readFile(indexPath);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        } catch {
            res.writeHead(404);
            res.end('Not found');
        }
    }
}

// ===== WebSocket Handlers =====
async function handleWebSocketMessage(message: any, ws: any, root: string) {
    switch (message.type) {
        case 'get_config':
            const config = await loadConfig(root);
            ws.send(JSON.stringify({ type: 'config_update', config }));
            break;

        case 'save_config':
            await saveConfig(root, message.config);
            ws.send(JSON.stringify({ type: 'config_saved', success: true }));
            break;
    }
}

function broadcast(clients: Set<any>, message: any) {
    const data = JSON.stringify(message);
    clients.forEach(client => {
        if (client.readyState === 1) { // OPEN
            client.send(data);
        }
    });
}

// ===== File Watcher =====
function watchConfigFile(root: string, onChange: (config: any) => void) {
    const configPaths = [
        path.join(root, 'lunx.build.json'),
        path.join(root, 'lunx.build.ts')
    ];

    configPaths.forEach(configPath => {
        watch(configPath, { persistent: false }, async () => {
            try {
                const config = await loadConfig(root);
                onChange(config);
            } catch (error) {
                console.error('[builder] Error watching config:', error);
            }
        });
    });
}

// ===== Helper Functions =====
function getBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

async function getAvailablePlugins() {
    // In production, this would scan the plugins directory
    return [
        { name: 'sample-plugin-esm', version: '1.0.0', description: 'Sample plugin', installed: true },
        { name: 'react-refresh', version: '2.0.0', description: 'React Fast Refresh', installed: true }
    ];
}

async function getBuildMetrics(root: string) {
    // In production, this would read actual build metrics
    return {
        buildTime: 0,
        bundleSize: 0,
        hmrUpdates: 0
    };
}
