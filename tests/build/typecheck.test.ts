/**
 * `server: { typecheck: true }`: `lunx dev` runs the project's TypeScript in
 * watch mode and sends each pass's errors to the browser (the overlay's Type
 * Errors tab), in place of vite-plugin-checker.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { stopProcess, removeDir } from './dev-process.js';
import { TscOutput, type TypeError } from '../../src/dev/typecheck.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repo, 'dist', 'cli.js');

describe('tsc output', () => {
    it('reads each pass, multi-line messages included', () => {
        const passes: TypeError[][] = [];
        const out = new TscOutput('/app', (errors) => passes.push(errors));
        out.push('10:01:02 AM - Starting compilation in watch mode...\n\n');
        out.push("src/a.ts(3,7): error TS2322: Type 'number' is not assignable to type 'string'.\n");
        out.push("src/b.tsx(10,1): error TS2345: Argument of type 'Promise<string>' is not assignable.\n  Type 'x' is missing.\n");
        out.push('10:01:04 AM - Found 2 errors. Watching for file changes.\n');
        out.push('10:02:00 AM - File change detected. Starting incremental compilation...\n10:02:01 AM - Found 0 errors. Watching for file changes.\n');
        expect(passes).toEqual([
            [
                { file: path.resolve('/app', 'src/a.ts'), line: 3, column: 7, code: 'TS2322', message: "Type 'number' is not assignable to type 'string'." },
                { file: path.resolve('/app', 'src/b.tsx'), line: 10, column: 1, code: 'TS2345', message: "Argument of type 'Promise<string>' is not assignable.\nType 'x' is missing." },
            ],
            [],
        ]);
    });
});

describe('server.typecheck', () => {
    let root: string;
    let dev: ChildProcess;
    const port = 5500 + Math.floor(Math.random() * 400);
    const messages: any[] = [];
    let socket: WebSocket;

    const next = async (match: (m: any) => boolean, timeout = 60_000) => {
        const deadline = Date.now() + timeout;
        for (;;) {
            const found = messages.find(match);
            if (found) {
                messages.splice(messages.indexOf(found), 1);
                return found;
            }
            if (Date.now() > deadline) throw new Error(`no matching message; got ${JSON.stringify(messages.map((m) => m.type))}`);
            await new Promise((r) => setTimeout(r, 100));
        }
    };

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-typecheck-'));
        fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
        const files: Record<string, string> = {
            'package.json': JSON.stringify({ name: 'typecheck-app', private: true, type: 'module', devDependencies: { typescript: '*' } }),
            'lunx.config.js': 'export default { server: { typecheck: true } };\n',
            'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022', 'DOM'], types: [] }, include: ['src'] }),
            'index.html': '<!DOCTYPE html><html><body><script type="module" src="/src/main.ts"></script></body></html>',
            'src/main.ts': "const title: string = 42;\ndocument.title = title;\n",
        };
        for (const [rel, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
            fs.writeFileSync(path.join(root, rel), content);
        }
        dev = spawn(process.execPath, [cli, 'dev', '--port', String(port)], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'ignore' });
        for (let i = 0; i < 200; i++) {
            if (await fetch(`http://localhost:${port}/`).then((r) => r.ok, () => false)) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        socket = new WebSocket(`ws://localhost:${port}/__lunx_hmr`);
        socket.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data))));
        await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve);
            socket.addEventListener('error', reject);
        });
    }, 60_000);

    afterAll(async () => {
        socket?.close();
        await stopProcess(dev);
        removeDir(root);
    });

    it('sends the type errors, then none once fixed', async () => {
        const failing = await next((m) => m.type === 'typecheck' && m.errors.length > 0);
        expect(failing.errors).toEqual([{ file: 'src/main.ts', line: 1, column: 7, message: expect.stringMatching(/^TS2322: Type 'number' is not assignable to type 'string'/) }]);
        fs.writeFileSync(path.join(root, 'src/main.ts'), "const title: string = 'fixed';\ndocument.title = title;\n");
        const fixed = await next((m) => m.type === 'typecheck' && m.errors.length === 0);
        expect(fixed.errors).toEqual([]);
    }, 90_000);
});
