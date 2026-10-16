/**
 * Starting a `lunx dev` from a test, waiting for it, stopping it and removing
 * its project, on every platform:
 *  - the port comes from the OS, so two servers never race for one;
 *  - a server that does not come up fails with its own output;
 *  - on Windows `kill()` ends only the CLI process (not the TypeScript
 *    watcher or other children it started), and their open handles keep the
 *    directory locked (EBUSY).
 */
import fs from 'fs';
import net, { type AddressInfo } from 'net';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

export interface DevProcess {
    child: ChildProcess;
    port: number;
    output: () => string;
}

/** A port nothing is listening on. */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, () => {
            const { port } = server.address() as AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

/** `lunx dev` in `root`; resolves once `path` answers 200 (up to `timeout` ms). */
export async function startDev(cli: string, root: string, { path = '/', timeout = 50_000 } = {}): Promise<DevProcess> {
    const port = await freePort();
    const child = spawn(process.execPath, [cli, 'dev', '--port', String(port)], { cwd: root, env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', (d) => (output += d));
    child.stderr!.on('data', (d) => (output += d));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && child.exitCode === null) {
        const ok = await fetch(`http://localhost:${port}${path}`, { headers: { accept: 'text/html' } }).then((r) => r.status === 200, () => false);
        if (ok) return { child, port, output: () => output };
        await new Promise((r) => setTimeout(r, 100));
    }
    await stopProcess(child);
    throw new Error(`lunx dev did not start on port ${port}:\n${output}`);
}

export async function stopProcess(child: ChildProcess | undefined): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill();
    await exited;
}

export function removeDir(dir: string | undefined): void {
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
