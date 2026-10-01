/**
 * lunx migrate — config and plugin migration from older Lunx versions
 */
import fs from 'node:fs';
import path from 'node:path';

interface MigrateOptions {
  yes?: boolean;
}

const LUNX_CONFIGS = ['lunx.config.ts', 'lunx.config.js', 'lunx.config.cjs', 'lunx.config.json', 'lunx.config.yaml', 'lunx.config.yml'];
const hasLunxConfig = (root: string) => LUNX_CONFIGS.some(f => fs.existsSync(path.join(root, f)));
const readPkg = (root: string): any => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
};

/** Point package.json scripts and devDependencies at lunx. */
function rewriteScripts(root: string, from: 'vite' | 'cra'): void {
  const pkgPath = path.join(root, 'package.json');
  const pkg = readPkg(root);
  if (!pkg) return;
  const swaps: Array<[RegExp, string]> = from === 'vite'
    ? [[/\bvite build\b/g, 'lunx build'], [/\bvite preview\b/g, 'lunx preview'], [/\bvite( dev| serve)?\b(?! (build|preview))/g, 'lunx dev']]
    : [[/\breact-scripts start\b/g, 'lunx dev'], [/\breact-scripts build\b/g, 'lunx build']];
  let changed = 0;
  for (const [name, cmd] of Object.entries<string>(pkg.scripts ?? {})) {
    let next = cmd;
    for (const [re, to] of swaps) next = next.replace(re, to);
    if (next !== cmd) { pkg.scripts[name] = next; changed++; }
  }
  pkg.devDependencies ??= {};
  if (!pkg.devDependencies['lunx-dev'] && !pkg.dependencies?.['lunx-dev']) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const own = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    pkg.devDependencies['lunx-dev'] = `^${own.version}`;
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`  ✅ package.json: ${changed} script(s) now use lunx; added lunx-dev — run your package manager's install`);
}

function writeLunxConfig(root: string, fields: Record<string, unknown>, comments: string[] = []): void {
  const body = JSON.stringify(fields, null, 2).replace(/"([A-Za-z_$][\w$]*)":/g, '$1:');
  const header = comments.map(c => `// ${c}\n`).join('');
  fs.writeFileSync(
    path.join(root, 'lunx.config.ts'),
    `import { defineConfig } from 'lunx-dev';\n\n${header}export default defineConfig(${body});\n`,
    'utf8'
  );
  console.log('  ✅ Wrote lunx.config.ts');
}

type Migration = { id: string; title: string; detect: (root: string) => unknown; apply: (root: string) => void | Promise<void> };

const MIGRATIONS: Migration[] = [
  {
    id: 'M10',
    title: 'Vite → Lunx (vite.config → lunx.config.ts, scripts)',
    detect: (root: string) =>
      !hasLunxConfig(root) && ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.cts']
        .find(f => fs.existsSync(path.join(root, f))),
    apply: async (root: string) => {
      const { readViteConfig } = await import('../config/vite-compat.js');
      const foreign = await readViteConfig(root);
      if (!foreign) return;
      const comments = [`Migrated from ${foreign.file} by \`lunx migrate\`.`];
      if (foreign.plugins.length) {
        comments.push(`Vite plugins to port by hand (Rollup-compatible, add to plugins: []): ${foreign.plugins.map(p => p.name).join(', ')}`);
      }
      for (const note of foreign.notes) comments.push(note);
      writeLunxConfig(root, foreign.config, comments);
      rewriteScripts(root, 'vite');
    }
  },
  {
    id: 'M11',
    title: 'Create React App → Lunx (index.html, lunx.config.ts, scripts)',
    detect: (root: string) => {
      const pkg = readPkg(root);
      const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
      return !hasLunxConfig(root) && deps['react-scripts'] && fs.existsSync(path.join(root, 'public', 'index.html')) ? root : undefined;
    },
    apply: (root: string) => {
      const entry = ['src/index.tsx', 'src/index.jsx', 'src/index.ts', 'src/index.js'].find(f => fs.existsSync(path.join(root, f))) ?? 'src/index.js';
      const target = path.join(root, 'index.html');
      if (!fs.existsSync(target)) {
        let html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8').replace(/%PUBLIC_URL%/g, '');
        const tag = `    <script type="module" src="/${entry}"></script>\n`;
        html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${tag}  </body>`) : html + tag;
        fs.writeFileSync(target, html, 'utf8');
        console.log(`  ✅ Wrote index.html (from public/index.html, entry /${entry})`);
      }
      writeLunxConfig(root, { framework: 'react' }, ['Migrated from Create React App by `lunx migrate`.', 'REACT_APP_* variables keep working via process.env and import.meta.env.']);
      rewriteScripts(root, 'cra');
    }
  },
  {
    id: 'M01',
    title: 'Rename nuclie.config.* → lunx.config.*',
    detect: (root: string) =>
      ['nuclie.config.js', 'nuclie.config.ts', 'nuclie.config.json'].find(f =>
        fs.existsSync(path.join(root, f))
      ),
    apply: (root: string) => {
      const old = ['nuclie.config.js', 'nuclie.config.ts', 'nuclie.config.json'].find(f =>
        fs.existsSync(path.join(root, f))
      );
      if (!old) return;
      const ext = path.extname(old);
      const newName = `lunx.config${ext}`;
      fs.renameSync(path.join(root, old), path.join(root, newName));
      console.log(`  ✅ Renamed ${old} → ${newName}`);
    }
  },
  {
    id: 'M02',
    title: 'Rewrite @nuclie/* imports → @lunx/* in package.json',
    detect: (root: string) => {
      const pkgPath = path.join(root, 'package.json');
      if (!fs.existsSync(pkgPath)) return undefined;
      const content = fs.readFileSync(pkgPath, 'utf8');
      return content.includes('@nuclie/') ? pkgPath : undefined;
    },
    apply: (root: string) => {
      const pkgPath = path.join(root, 'package.json');
      if (!fs.existsSync(pkgPath)) return;
      const content = fs.readFileSync(pkgPath, 'utf8');
      const updated = content.replace(/@nuclie\//g, '@lunx/');
      fs.writeFileSync(pkgPath, updated, 'utf8');
      console.log('  ✅ Rewrote @nuclie/* → @lunx/* in package.json');
    }
  },
  {
    id: 'M03',
    title: 'Rewrite @nuclie/* imports in source files',
    detect: (root: string) => {
      const srcDir = path.join(root, 'src');
      if (!fs.existsSync(srcDir)) return undefined;
      const files = findSourceFiles(srcDir);
      return files.find(f => fs.readFileSync(f, 'utf8').includes('@nuclie/')) ? srcDir : undefined;
    },
    apply: (root: string) => {
      const srcDir = path.join(root, 'src');
      if (!fs.existsSync(srcDir)) return;
      const files = findSourceFiles(srcDir);
      let count = 0;
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        if (content.includes('@nuclie/')) {
          fs.writeFileSync(file, content.replace(/@nuclie\//g, '@lunx/'), 'utf8');
          count++;
        }
      }
      console.log(`  ✅ Rewrote @nuclie/* → @lunx/* in ${count} source file(s)`);
    }
  }
];

function findSourceFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', '.lunx', 'dist', 'build_output'].includes(entry.name)) {
      results.push(...findSourceFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

export async function runMigrate(root: string, options: MigrateOptions = {}): Promise<void> {
  console.log('\n🔄 Lunx Migration Tool\n' + '─'.repeat(40));

  const applicable = MIGRATIONS.filter(m => m.detect(root));

  if (applicable.length === 0) {
    console.log('\n  ✅ No migrations needed — project is up to date.\n');
    return;
  }

  console.log(`\n  Found ${applicable.length} migration(s):\n`);
  applicable.forEach(m => console.log(`  [${m.id}] ${m.title}`));

  if (!options.yes) {
    const readline = await import('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question('\n  Apply all? [Y/n] ', resolve);
    });
    rl.close();
    if (answer.toLowerCase() === 'n') {
      console.log('\n  Aborted. No changes made.\n');
      return;
    }
  }

  console.log('\n  Applying migrations...\n');
  for (const m of applicable) {
    console.log(`  → [${m.id}] ${m.title}`);
    await m.apply(root);
  }

  console.log('\n' + '─'.repeat(40));
  console.log('  ✅ Migration complete.\n');
}
