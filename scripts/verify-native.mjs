#!/usr/bin/env node
/**
 * Fail the build if the Rust N-API binary is not loadable locally.
 * Main npm pack must NOT embed .node (optional @lunx/native-* packages do).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync } from 'child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walkNodeBinaries(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'target') continue;
      walkNodeBinaries(p, out);
    } else if (e.name.startsWith('lunx_native') && e.name.endsWith('.node')) {
      out.push(p);
    }
  }
  return out;
}

const binaries = [
  ...walkNodeBinaries(path.join(root, 'packages')),
  path.join(root, 'lunx_native.node'),
  ...walkNodeBinaries(path.join(root, 'native')),
].filter((p, i, arr) => fs.existsSync(p) && arr.indexOf(p) === i);

if (binaries.length === 0) {
  console.error('❌ Native verify failed: no lunx_native*.node found (packages/ or package root).');
  console.error('   Run cargo + `npm run build:native`.');
  process.exit(1);
}

const loader = path.join(root, 'dist', 'native', 'index.js');
if (!fs.existsSync(loader)) {
  console.error('❌ Native verify failed: dist/native/index.js missing.');
  process.exit(1);
}

const { engineUsed, helloRust } = await import(pathToFileURL(loader).href);
if (engineUsed !== 'native') {
  console.error(`❌ Native verify failed: engineUsed=${engineUsed} (expected native).`);
  process.exit(1);
}
const hello = typeof helloRust === 'function' ? helloRust() : '';
if (!String(hello).includes('Rust')) {
  console.error(`❌ Native verify failed: helloRust()=${hello}`);
  process.exit(1);
}

console.log(`✅ Native engine loaded: ${hello}`);
console.log(`✅ Native binaries available for optional packages: ${binaries.map((f) => path.relative(root, f)).join(', ')}`);

const packed = execSync('npm pack --ignore-scripts --dry-run --json', {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let files = [];
try {
  const json = JSON.parse(packed);
  const entry = Array.isArray(json) ? json[0] : json;
  files = entry?.files?.map((f) => f.path || f) ?? [];
} catch {
  files = packed.split('\n').map((l) => l.trim()).filter(Boolean);
}

const hasNativeInMain = files.some((f) => String(f).includes('lunx_native') && String(f).includes('.node'));
if (hasNativeInMain) {
  console.error('❌ Main lunx-dev pack must NOT embed lunx_native*.node — use @lunx/native-* optionalDependencies.');
  process.exit(1);
}
console.log('✅ Main npm pack is lean (native via optionalDependencies)');
