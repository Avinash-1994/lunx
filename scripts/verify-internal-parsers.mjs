/**
 * Differential check: our YAML and .env parsers against js-yaml and dotenv.
 * Run with: npx tsx scripts/verify-internal-parsers.mjs
 */
import assert from 'node:assert';
import jsyaml from 'js-yaml';
import dotenv from 'dotenv';
import * as ours from '../src/internal/yaml.ts';
import * as ourEnv from '../src/internal/dotenv.ts';

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

function sameAsJsYaml(name, text) {
    let expected;
    let actual;
    try {
        expected = jsyaml.load(text);
    } catch (e) {
        check(`${name} (js-yaml threw: ${e.message})`, false);
        return;
    }
    try {
        actual = ours.load(text);
    } catch (e) {
        check(name, false, `ours threw: ${e.message}`);
        return;
    }
    let ok = true;
    try {
        assert.deepStrictEqual(actual, expected);
    } catch {
        ok = false;
    }
    check(name, ok, ok ? '' : `\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}

// ── YAML ────────────────────────────────────────────────────────────────────
sameAsJsYaml('flat mapping', 'name: lunx\nversion: 1.0.3\n');
sameAsJsYaml('typed scalars', 'a: 1\nb: 2.5\nc: true\nd: false\ne: null\nf: ~\ng: "7"\n');
sameAsJsYaml('nested mapping', 'server:\n  port: 3000\n  open: true\n  host: localhost\n');
sameAsJsYaml('deep nesting', 'a:\n  b:\n    c:\n      d: deep\n');
sameAsJsYaml('sequence of scalars', 'targets:\n  - chrome90\n  - firefox88\n  - safari14\n');
sameAsJsYaml('sequence of mappings', 'plugins:\n  - name: env\n    enabled: true\n  - name: pwa\n    enabled: false\n');
sameAsJsYaml('inline flow seq', 'targets: [chrome90, firefox88, safari14]\n');
sameAsJsYaml('inline flow map', 'shared: { singleton: true, eager: false }\n');
sameAsJsYaml('quoted strings', `a: "hello: world"\nb: 'it''s fine'\nc: "tab\\there"\n`);
sameAsJsYaml('comments', '# leading\nname: lunx # trailing\n# between\nport: 3000\n');
sameAsJsYaml('empty value', 'a:\nb: 2\n');
sameAsJsYaml('literal block scalar', 'script: |\n  line one\n  line two\n');
sameAsJsYaml('literal block strip', 'script: |-\n  line one\n  line two\n');
sameAsJsYaml('folded block scalar', 'text: >\n  one\n  two\n');
sameAsJsYaml('string with colon in url', 'remote: http://localhost:3001/remoteEntry.js\n');
sameAsJsYaml('leading zeros stay strings', 'zip: 01234\nver: 1.0.3\n');
sameAsJsYaml('negative and exponent', 'a: -5\nb: 1e3\nc: -2.5e-3\n');
sameAsJsYaml('mixed nesting', 'build:\n  minify: true\n  targets:\n    - es2020\n  options:\n    sourcemap: external\n');
sameAsJsYaml('sequence at key indent', 'list:\n- a\n- b\n');
sameAsJsYaml('anchors and aliases', 'base: &b\n  port: 3000\nuse: *b\n');

// A realistic lunx.config.yaml
sameAsJsYaml(
    'realistic config',
    `framework: react
entry:
  - src/main.tsx
outDir: dist
server:
  port: 3000
  open: true
  proxy:
    /api: http://localhost:8080
build:
  minify: true
  sourcemap: external
  splitting: true
  targets: [chrome90, firefox88, safari14]
security:
  vulnSeverity: high
federation:
  name: hostApp
  remotes:
    navRemote: http://localhost:3001/remoteEntry.js
  shared:
    react: { singleton: true }
    react-dom: { singleton: true }
`,
);

// ── .env ────────────────────────────────────────────────────────────────────
function sameAsDotenv(name, text) {
    const expected = dotenv.parse(text);
    const actual = ourEnv.parse(text);
    let ok = true;
    try {
        assert.deepStrictEqual(actual, expected);
    } catch {
        ok = false;
    }
    check(name, ok, ok ? '' : `\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
}

sameAsDotenv('env basic', 'A=1\nB=two\n');
sameAsDotenv('env export prefix', 'export A=1\nexport B=two\n');
sameAsDotenv('env quotes', `A="hello world"\nB='single'\nC=\`tick\`\n`);
sameAsDotenv('env empty', 'A=\nB=2\n');
sameAsDotenv('env comments', '# top\nA=1 # trailing\n# mid\nB=2\n');
sameAsDotenv('env escapes in double quotes', 'A="line1\\nline2"\nB="tab\\there"\n');
sameAsDotenv('env multiline quoted', 'KEY="line1\nline2\nline3"\nAFTER=1\n');
sameAsDotenv('env hash inside quotes', 'A="not#comment"\nB=raw#notcomment\n');
sameAsDotenv('env url value', 'API=http://localhost:8080/path?x=1\n');
sameAsDotenv('env dotted and dashed keys', 'A.B=1\nC-D=2\n');
sameAsDotenv('env whitespace around equals', 'A = 1\nB= 2\nC =3\n');

// expansion is ours-only (dotenv needs dotenv-expand for this)
const expanded = ourEnv.expand(ourEnv.parse('BASE=/api\nFULL=${BASE}/v1\nBARE=$BASE/v2\nMISS=${NOPE:-fallback}\n'), {});
check('env ${VAR} expansion', expanded.FULL === '/api/v1', expanded.FULL);
check('env $VAR expansion', expanded.BARE === '/api/v2', expanded.BARE);
check('env :- fallback', expanded.MISS === 'fallback', expanded.MISS);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
