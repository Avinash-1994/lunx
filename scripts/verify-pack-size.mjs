#!/usr/bin/env node
/**
 * Enforce lean main package size (≤1.6 MB unpacked JS).
 * Native binary must NOT be in the main pack — it ships as @lunx/native-*.
 */
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_JS_BYTES = 1.6 * 1024 * 1024;

const dry = execSync('npm pack --ignore-scripts --dry-run --json', {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

let files = [];
try {
  const json = JSON.parse(dry);
  const entry = Array.isArray(json) ? json[0] : json;
  files = entry?.files ?? [];
} catch {
  console.error('❌ verify-pack-size: could not parse npm pack --json');
  process.exit(1);
}

let jsBytes = 0;
let nativeCopies = [];
for (const f of files) {
  const rel = f.path || f;
  const size = Number(f.size ?? 0);
  const name = path.basename(String(rel));
  if (name.startsWith('lunx_native') && name.endsWith('.node')) {
    nativeCopies.push({ rel, size });
    continue;
  }
  jsBytes += size;
}

console.log(`📦 Main pack JS/docs size: ${(jsBytes / 1024 / 1024).toFixed(2)} MB (limit ${MAX_JS_BYTES / 1024 / 1024} MB)`);
console.log(`🦀 Native .node copies in MAIN pack: ${nativeCopies.length} (must be 0)`);

if (jsBytes > MAX_JS_BYTES) {
  console.error(`❌ Pack JS/docs exceeds ${MAX_JS_BYTES / 1024 / 1024} MB.`);
  process.exit(1);
}

if (nativeCopies.length > 0) {
  console.error('❌ Native binary must ship via @lunx/native-* optional packages, not lunx-dev.');
  for (const n of nativeCopies) console.error(`   - ${n.rel}`);
  process.exit(1);
}

console.log('✅ Pack size OK (JS ≤ 1.6 MB, native optional)');
