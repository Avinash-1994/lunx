#!/usr/bin/env node
import { promises as fs } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true }).catch(() => { });
}

async function copyIfExists(src, dest) {
  try {
    await fs.copyFile(src, dest);
    console.log(`Copied: ${src} -> ${dest}`);
  } catch { }
}

async function copyAll(patternDir, filterExt, outDir) {
  try {
    const entries = await fs.readdir(patternDir);
    await ensureDir(outDir);
    for (const e of entries) {
      if (e.endsWith(filterExt)) {
        const src = join(patternDir, e);
        const dest = join(outDir, e);
        await copyIfExists(src, dest);
      }
    }
  } catch { }
}

(async () => {
  await ensureDir(distDir);

  await copyAll(join(rootDir, 'src', 'plugins'), '.mjs', join(distDir, 'plugins'));
  await copyAll(join(rootDir, 'src', 'runtime'), '.js', join(distDir, 'runtime'));

  // Mirror dist/src/* → dist/* so tests using '../dist/config/index.js' resolve correctly.
  // tsc with no rootDir and include:['src/**/*'] outputs dist/src/**  but tests expect dist/**
  async function mirrorDir(srcDir, destDir) {
    try {
      const entries = await fs.readdir(srcDir, { withFileTypes: true });
      await ensureDir(destDir);
      for (const e of entries) {
        const s = join(srcDir, e.name);
        const d = join(destDir, e.name);
        if (e.isDirectory()) {
          await mirrorDir(s, d);
        } else if (e.name.endsWith('.js') || e.name.endsWith('.d.ts') || e.name.endsWith('.js.map')) {
          await copyIfExists(s, d);
        }
      }
    } catch { }
  }
  await mirrorDir(join(distDir, 'src'), distDir);

  // Ensure CLI entry points are executable when installed as a local package
  const executables = ['cli.js', 'create-lunx.js'];
  for (const file of executables) {
    const target = join(distDir, file);
    await fs.chmod(target, 0o755).catch(() => { });
  }

  await fs.rm(join(distDir, 'src'), { recursive: true, force: true }).catch(() => {});
  await fs.rm(join(distDir, 'test'), { recursive: true, force: true }).catch(() => {});
  await fs.rm(join(distDir, 'visual'), { recursive: true, force: true }).catch(() => {});
  await fs.rm(join(distDir, 'repro'), { recursive: true, force: true }).catch(() => {});
  await fs.rm(join(distDir, 'test-server.js'), { force: true }).catch(() => {});
  await fs.rm(join(distDir, 'test-server.d.ts'), { force: true }).catch(() => {});
  await fs.rm(join(distDir, 'plugins', 'testSandbox.js'), { force: true }).catch(() => {});
  await fs.rm(join(distDir, 'plugins', 'testSandbox.d.ts'), { force: true }).catch(() => {});

  // Prune non-runtime folders from dist so the published JS footprint stays ≤ ~1.6 MB.
  const pruneDirs = [
    'ai', 'visual', 'marketplace', 'packages', 'repro', 'benchmarks',
    'test', 'tests', 'e2e',
  ];
  for (const d of pruneDirs) {
    await fs.rm(join(distDir, d), { recursive: true, force: true }).catch(() => {});
  }

  // Remove ANY .node from dist/ — native ships via optional @lunx/native-* packages
  // so lunx-dev stays competitive on download size (≤1.6MB), like esbuild/@swc/core.
  try {
    const walk = async (dir) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.name.endsWith('.node')) await fs.rm(p, { force: true }).catch(() => {});
      }
    };
    await walk(distDir);
  } catch { }

  const nativeDir = join(rootDir, 'native');
  const distNativeDir = join(distDir, 'native');
  await ensureDir(distNativeDir);

  // Refresh optional platform package binary (published separately)
  const optionalNativeDir = join(rootDir, 'packages', 'lunx-native-linux-x64-gnu');
  await ensureDir(optionalNativeDir);
  let binarySrc = join(rootDir, 'lunx_native.node');
  try {
    await fs.access(binarySrc);
  } catch {
    binarySrc = '';
    try {
      const entries = await fs.readdir(nativeDir);
      const plat = entries.find((e) => e.startsWith('lunx_native') && e.endsWith('.node'));
      if (plat) binarySrc = join(nativeDir, plat);
    } catch { }
  }
  if (binarySrc) {
    await copyIfExists(binarySrc, join(optionalNativeDir, 'lunx_native.linux-x64-gnu.node'));
    // Keep a local copy for monorepo/dev loads without requiring npm install of the optional pkg
    await copyIfExists(binarySrc, join(rootDir, 'lunx_native.node'));
  }

  // Symlink optional package into node_modules for local verify / tests
  try {
    const nmScope = join(rootDir, 'node_modules', '@lunx');
    await ensureDir(nmScope);
    const linkPath = join(nmScope, 'native-linux-x64-gnu');
    await fs.rm(linkPath, { recursive: true, force: true }).catch(() => {});
    await fs.symlink(optionalNativeDir, linkPath, 'junction').catch(async () => {
      // Fallback: copy package.json + index (binary already there) via relative symlink
      await fs.symlink(relative(nmScope, optionalNativeDir), linkPath, 'dir').catch(() => {});
    });
  } catch { }

  // Keep a small JS napi helper next to the loader (not another .node copy)
  await copyIfExists(join(nativeDir, 'index.js'), join(distNativeDir, 'napi-loader.cjs'));
  await copyIfExists(join(nativeDir, 'index.cjs'), join(distNativeDir, 'index.cjs'));

  console.log('Post-build copy and cleanup complete');
})();
