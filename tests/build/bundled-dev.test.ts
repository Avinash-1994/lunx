/**
 * `server: { bundle: true }`: `lunx dev` serves the page as bundles from
 * Rolldown's dev engine, and sends each save as a patch over the HMR socket.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { startDev, stopProcess, removeDir } from './dev-process.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'dist', 'cli.js');

describe('server.bundle', () => {
    let root: string;
    let dev: ChildProcess;
    let port: number;
    let socket: WebSocket;
    const messages: any[] = [];
    const get = (url: string) => fetch(`http://localhost:${port}${url}`, { headers: { accept: url === '/' ? 'text/html' : '*/*' } });
    const waitFor = async (pred: (m: any) => boolean, ms = 15_000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            const hit = messages.find(pred);
            if (hit) return hit;
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`no matching message in ${JSON.stringify(messages.map((m) => m.type))}`);
    };

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-bundled-dev-'));
        fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
        const files: Record<string, string> = {
            'package.json': JSON.stringify({ name: 'bundled-app', private: true, type: 'module', dependencies: { react: '*', 'react-dom': '*' } }),
            'lunx.config.js': 'export default { server: { bundle: true } };\n',
            'index.html': '<!DOCTYPE html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
            'src/main.jsx': "import { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './style.css';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
            'src/App.jsx': "import { useState } from 'react';\nimport logo from './logo.svg';\nexport default function App() {\n  const [n, setN] = useState(0);\n  return <h1 onClick={() => setN(n + 1)}><img src={logo} />first {n}</h1>;\n}\n",
            'src/style.css': 'h1 { color: rebeccapurple; }\n',
            'src/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
        };
        for (const [rel, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
            fs.writeFileSync(path.join(root, rel), content);
        }
        ({ child: dev, port } = await startDev(cli, root));
    }, 60_000);

    afterAll(async () => {
        socket?.close();
        await stopProcess(dev);
        removeDir(root);
    });

    it('points the page at its bundle, which carries the app, its deps, styles and assets', async () => {
        const html = await (await get('/')).text();
        expect(html).toContain('<script type="module" src="/@lunx/bundle/main.js"></script>');
        expect(html).not.toContain('/@lunx/hmr-client');
        const res = await get('/@lunx/bundle/main.js');
        expect(res.status).toBe(200);
        const code = await res.text();
        expect(code).toContain('first ');
        expect(code).toContain('createModuleHotContext');
        expect(code).toContain('el.textContent = "h1 {\\n  color: #639;');
        expect(code).toContain('"/src/logo.svg"');
        // React itself is in the bundle: nothing is pre-bundled or fetched module by module.
        expect(code).toMatch(/react-dom[\\/]cjs[\\/]react-dom-client\.development\.js/);
        expect((await get('/@lunx/bundle/main.js.map')).status).toBe(200);
    }, 30_000);

    it('sends a save as a patch to the page that asked for it', async () => {
        socket = new WebSocket(`ws://localhost:${port}/__lunx_hmr`);
        socket.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve);
            socket.addEventListener('error', reject);
        });
        socket.send(JSON.stringify({ type: 'lunx:bundle-hello', clientId: 'jest' }));
        await new Promise((r) => setTimeout(r, 300));
        const file = path.join(root, 'src/App.jsx');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('first', 'second'));
        const patch = await waitFor((m) => m.type === 'lunx:bundle-patch');
        expect(patch.changedIds).toContain('src/App.jsx');
        expect(patch.url).toMatch(/^\/@lunx\/bundle\/hmr\/jest\//);
        const code = await (await get(patch.url)).text();
        expect(code).toContain('registerFactory("src/App.jsx"');
        expect(code).toContain('second ');
        socket.send(JSON.stringify({ type: 'lunx:bundle-delivered', filename: patch.filename }));

        // A broken save reaches the page as an error (the overlay).
        fs.writeFileSync(file, 'export default function App( {\n');
        const error = await waitFor((m) => m.type === 'lunx:bundle-error');
        expect(error.message).toMatch(/App\.jsx/);
    }, 30_000);
});
