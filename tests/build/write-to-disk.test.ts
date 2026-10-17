/**
 * `server.writeToDisk`: what the dev server serves is also written to outDir at
 * its URL path; with server.bundle that folder is the whole app (page, bundles,
 * pre-bundled packages), rewritten after each save.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { startDev, stopProcess, removeDir } from './dev-process.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'dist', 'cli.js');
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

function project(config: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-disk-'));
    roots.push(root);
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const files: Record<string, string> = {
        'package.json': JSON.stringify({ name: 'disk-app', private: true, type: 'module', dependencies: { react: '*', 'react-dom': '*' } }),
        'lunx.config.js': config,
        'index.html': '<!DOCTYPE html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
        'src/main.jsx': "import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
        'src/App.jsx': "import logo from './logo.svg';\nexport default function App() { return <h1><img src={logo} />first</h1>; }\n",
        'src/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
        'public/robots.txt': 'hi',
    };
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
}

const waitFor = async (check: () => boolean, ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    return check();
};
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

describe('server.writeToDisk', () => {
    it('with server.bundle, writes the page, its bundles and packages, and rewrites them on a save', async () => {
        const root = project("export default { server: { bundle: true, writeToDisk: true } };");
        const dist = path.join(root, 'dist');
        const { child } = await startDev(cli, root);
        try {
            expect(await waitFor(() => read(path.join(dist, '@lunx/bundle/main.js')).includes('first'))).toBe(true);
            // The crawl writes as it goes: each file in turn.
            expect(await waitFor(() => read(path.join(dist, 'index.html')).includes('/@lunx/bundle/main.js'))).toBe(true);
            expect(await waitFor(() => fs.existsSync(path.join(dist, '@lunx-deps/react-dom_client.js')))).toBe(true);
            expect(await waitFor(() => fs.existsSync(path.join(dist, 'src/logo.svg')))).toBe(true);
            expect(await waitFor(() => read(path.join(dist, 'robots.txt')) === 'hi')).toBe(true);
            const app = path.join(root, 'src/App.jsx');
            fs.writeFileSync(app, read(app).replace('first', 'second'));
            expect(await waitFor(() => read(path.join(dist, '@lunx/bundle/main.js')).includes('second'))).toBe(true);
        } finally {
            await stopProcess(child);
        }
    }, 60_000);

    it('without bundling, writes each module the page loads, and a filter picks the files', async () => {
        const root = project("export default { server: { writeToDisk: (file) => !file.endsWith('.svg') } };");
        const dist = path.join(root, 'dist');
        const { child } = await startDev(cli, root);
        try {
            expect(await waitFor(() => read(path.join(dist, 'src/App')).includes('first'))).toBe(true);
            expect(await waitFor(() => read(path.join(dist, 'src/main.jsx')).includes('createRoot'))).toBe(true);
            expect(await waitFor(() => fs.existsSync(path.join(dist, '@lunx-deps/react-dom_client.js')))).toBe(true);
            expect(fs.existsSync(path.join(dist, 'src/logo.svg'))).toBe(false);
        } finally {
            await stopProcess(child);
        }
    }, 60_000);
});
