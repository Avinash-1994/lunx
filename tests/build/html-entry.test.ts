import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    expandHtmlEntries,
    rewriteHtmlForProduction,
    extractHtmlModuleEntries,
} from '../../src/build/html-entry.js';

function tmpProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lunx-html-entry-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
    }
    return dir;
}

describe('HTML entry resolution', () => {
    it('extracts module scripts from a Vite-style index.html', () => {
        const root = tmpProject({
            'index.html': `<!DOCTYPE html><html><body>
              <div id="root"></div>
              <script type="module" src="/src/main.tsx"></script>
            </body></html>`,
            'src/main.tsx': 'export {}',
        });
        const html = fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
        const extracted = extractHtmlModuleEntries(html, path.join(root, 'index.html'), root);
        expect(extracted.scripts).toEqual(['src/main.tsx']);
    });

    it('expands index.html to the real app entry instead of bundling HTML as JS', () => {
        const root = tmpProject({
            'index.html': `<!doctype html><script type="module" src="/src/main.tsx"></script>`,
            'src/main.tsx': 'export {}',
        });
        const resolved = expandHtmlEntries(['index.html'], root);
        expect(resolved.entryPoints).toEqual(['src/main.tsx']);
        expect(resolved.htmlTemplates).toContain('index.html');
    });

    it('falls back to src/main.ts when HTML has no module scripts', () => {
        const root = tmpProject({
            'index.html': `<!doctype html><title>Marketing</title>`,
            'src/main.ts': 'export {}',
        });
        const resolved = expandHtmlEntries(['index.html'], root);
        expect(resolved.entryPoints).toEqual(['src/main.ts']);
    });

    it('rewrites the original Alpine shell instead of a generic Lunx page', () => {
        const html = `<!DOCTYPE html>
<html><body>
  <div id="root" x-data="{ items: [] }"><h1>Alpine Todos</h1></div>
  <script type="module" src="/src/main.ts"></script>
</body></html>`;
        const out = rewriteHtmlForProduction(
            html,
            [{ type: 'js', fileName: 'assets/main.abcd1234.bundle.js', entry: 'src/main.ts' }],
            { htmlFileAbs: '/app/index.html', rootDir: '/app' }
        );
        expect(out).toContain('Alpine Todos');
        expect(out).toContain('x-data');
        expect(out).toContain('/assets/main.abcd1234.bundle.js');
        expect(out).not.toContain('/src/main.ts');
        expect(out).not.toContain('Lunx Build');
    });

    it('preserves custom elements used by Lit', () => {
        const html = `<!DOCTYPE html><html><body>
          <my-element></my-element>
          <script type="module" src="/src/main.ts"></script>
        </body></html>`;
        const out = rewriteHtmlForProduction(
            html,
            [{ type: 'js', fileName: 'assets/main.deadbeef.bundle.js', entry: 'src/main.ts' }],
            { htmlFileAbs: '/app/index.html', rootDir: '/app' }
        );
        expect(out).toContain('<my-element></my-element>');
        expect(out).toContain('/assets/main.deadbeef.bundle.js');
    });
});
