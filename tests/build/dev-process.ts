/**
 * Stopping a `lunx dev` started by a test, and removing its project, on every
 * platform: on Windows `kill()` ends only the CLI process (not the TypeScript
 * watcher or other children it started), and their open handles keep the
 * directory locked (EBUSY).
 */
import fs from 'fs';
import { spawnSync, type ChildProcess } from 'child_process';

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
