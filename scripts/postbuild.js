#!/usr/bin/env node
import { promises as fs } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');

/**
 * The contiguous run of import/export-from statements at the top of a module,
 * which is where every static import in tsc's ESM output lives.
 */
function leadingImportBlock(code) {
  const lines = code.split('\n');
  const out = [];
  let depth = 0;
  for (const line of lines) {
    const t = line.trim();
    if (depth > 0) {
      out.push(line);
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      continue;
    }
    if (t === '' || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || /^["']use strict["'];?$/.test(t)) {
      continue;
    }
    // `import ...`, `export { ... } from ...` and `export * from ...` only —
    // not `export class X {`, which would otherwise pull the whole class body
    // in as part of the header.
    if (/^import\b/.test(t) || /^export\s*[{*]/.test(t) || /^export\b.*\bfrom\b/.test(t)) {
      out.push(line);
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      continue;
    }
    break;
  }
  return out.join('\n');
}

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
  await fs.rm(join(distDir, 'repro'), { recursive: true, force: true }).catch(() => {});
  // visual/client is browser-side WebGL code for the graph UI that nothing in
  // dist imports and that pulls in `three`, which is not a dependency.
  await fs.rm(join(distDir, 'visual', 'client'), { recursive: true, force: true }).catch(() => {});
  await fs.rm(join(distDir, 'test-server.js'), { force: true }).catch(() => {});
  await fs.rm(join(distDir, 'test-server.d.ts'), { force: true }).catch(() => {});
  await fs.rm(join(distDir, 'plugins', 'testSandbox.js'), { force: true }).catch(() => {});
  await fs.rm(join(distDir, 'plugins', 'testSandbox.d.ts'), { force: true }).catch(() => {});

  // Prune non-runtime folders from dist so the published JS footprint stays lean.
  // Only folders nothing in dist imports may appear here — `ai`, `visual` and
  // `marketplace` were pruned while `cli/commands/build.js`, `index.js` and
  // `dev/devServer.js` still imported them, which made `lunx build` and
  // `require('lunx-dev')` fail outright in the published package. The import
  // check at the end of this script now fails the build if that happens again.
  // `test` stays: `lunx test` loads dist/test/runner.js.
  const pruneDirs = [
    'packages', 'repro', 'benchmarks',
    'tests', 'e2e',
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

  // Integrity check: every relative specifier left in dist must resolve to a
  // file that survived the pruning above. A missing one is not a warning — the
  // module throws ERR_MODULE_NOT_FOUND the first time a user hits that code
  // path, which is how `lunx build` shipped broken.
  const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.[^'"]*)['"]/g;
  // Specifiers that are absent by design and already guarded at the call site:
  // monorepo-only workspace packages (dev-server extras that degrade to a
  // no-op outside the repo) and the WASI build of the native addon.
  const OPTIONAL = [/(\.\.\/)+packages\//, /\.wasi\.cjs$/];
  const missing = [];

  // Same idea for external packages, but only for *static* imports. A lazy
  // `await import('svelte')` inside a try/catch is how optional integrations
  // are meant to work; a top-level `import ... from 'glob'` on an undeclared
  // package takes the whole module down the moment anything touches it, which
  // is how `acorn-walk`, `glob` and `puppeteer` broke `lunx build` and
  // `lunx audit` in a published install while passing every in-repo test
  // (the repo's own devDependencies supplied them).
  const STATIC_BARE = [
    /^[ \t]*import[^;\n]*?\bfrom\s*['"]([^'".][^'"]*)['"]/gm,
    /^[ \t]*export[^;\n]*?\bfrom\s*['"]([^'".][^'"]*)['"]/gm,
    /^[ \t]*import\s*['"]([^'".][^'"]*)['"]/gm,
  ];
  const pkgJson = JSON.parse(await fs.readFile(join(rootDir, 'package.json'), 'utf8'));
  // An *optional* peer is not installed by default, so a static import of one
  // still crashes the module — `axe-core` reached a published install that way
  // and took `lunx report` down with ERR_MODULE_NOT_FOUND. Only peers npm
  // actually installs count as satisfying a top-level import.
  const optionalPeers = new Set(
    Object.entries(pkgJson.peerDependenciesMeta || {})
      .filter(([, meta]) => meta && meta.optional)
      .map(([name]) => name)
  );
  const declared = new Set([
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.peerDependencies || {}).filter((n) => !optionalPeers.has(n)),
    ...Object.keys(pkgJson.optionalDependencies || {}),
  ]);
  const { builtinModules } = await import('node:module');
  const builtins = new Set(builtinModules);
  const undeclared = [];
  const checkImports = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await checkImports(p);
        continue;
      }
      if (!/\.(js|cjs|mjs)$/.test(e.name)) continue;
      // templates/ holds scaffold source emitted into the user's project; its
      // import strings are not resolved here.
      if (relative(distDir, p).split(/[\\/]/)[0] === 'templates') continue;
      const code = await fs.readFile(p, 'utf8');
      for (const m of code.matchAll(SPECIFIER)) {
        const spec = m[1];
        // `.node` is skipped: the napi loader probes every platform binary by
        // name and only one of them is ever present, inside a try/catch.
        if (!/\.(js|cjs|mjs|json)$/.test(spec)) continue;
        if (OPTIONAL.some((re) => re.test(spec))) continue;
        const target = join(dirname(p), spec);
        try {
          await fs.access(target);
        } catch {
          missing.push(`${relative(distDir, p)} -> ${spec}`);
        }
      }

      // Only the file's leading import block counts. Several modules build
      // scaffold or virtual-module source as template literals containing
      // `import ... from '...'`, and those strings are not this file's imports.
      const header = leadingImportBlock(code);
      for (const re of STATIC_BARE) {
        for (const m of header.matchAll(re)) {
          const spec = m[1];
          if (spec.startsWith('node:')) continue;
          const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          if (builtins.has(name) || declared.has(name)) continue;
          if (name.startsWith('lunx-native-') || name.startsWith('@lunx/native-')) continue;
          undeclared.push(`${relative(distDir, p)} -> ${name}`);
        }
      }
    }
  };
  await checkImports(distDir);
  if (missing.length > 0) {
    console.error(`\n❌ ${missing.length} dangling import(s) in dist:`);
    for (const m of missing.slice(0, 60)) console.error(`   ${m}`);
    if (missing.length > 60) console.error(`   ... and ${missing.length - 60} more`);
    console.error('Remove the folder from pruneDirs, or make the import optional.\n');
    process.exitCode = 1;
    return;
  }

  if (undeclared.length > 0) {
    const unique = [...new Set(undeclared)];
    console.error(`\n❌ ${unique.length} static import(s) of undeclared packages in dist:`);
    for (const u of unique.slice(0, 60)) console.error(`   ${u}`);
    if (unique.length > 60) console.error(`   ... and ${unique.length - 60} more`);
    console.error('Declare the package, or load it with a guarded dynamic import.\n');
    process.exitCode = 1;
    return;
  }

  console.log('Post-build copy and cleanup complete');
})();
