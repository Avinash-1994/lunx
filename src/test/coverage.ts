import fs from 'fs';
import path from 'path';
import * as acorn from 'acorn';
import { simple } from '../internal/ast-walk.js';

/**
 * Coverage Audit Tool
 * Performs static analysis of source code vs test files to estimate coverage
 */

const SRC_DIR = path.resolve(process.cwd(), 'src');
const TEST_DIR = path.resolve(process.cwd(), 'tests');
const OUTPUT_FILE = path.resolve(process.cwd(), 'COVERAGE_GAP_ANALYSIS.md');

interface FileStats {
    path: string;
    exports: string[];
    loc: number;
}

interface TestStats {
    path: string;
    tests: number;
    suites: number;
}

interface GapAnalysis {
    file: string;
    exportsContext: string[];
    potentialTests: string[];
    status: 'MISSING' | 'PARTIAL' | 'COVERED';
}

function getAllFiles(dir: string, ext = '.ts'): string[] {
    let results: string[] = [];
    if (!fs.existsSync(dir)) return results;

    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getAllFiles(filePath, ext));
        } else {
            if (file.endsWith(ext) && !file.endsWith('.d.ts')) {
                results.push(filePath);
            }
        }
    });
    return results;
}

function analyzeSourceFile(filePath: string): FileStats {
    const code = fs.readFileSync(filePath, 'utf-8');
    const exports: string[] = [];

    try {
        const ast = acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest' });
        simple(ast, {
            ExportNamedDeclaration(node: any) {
                if (node.declaration) {
                    if (node.declaration.type === 'FunctionDeclaration') {
                        exports.push(node.declaration.id.name);
                    } else if (node.declaration.type === 'ClassDeclaration') {
                        exports.push(node.declaration.id.name);
                    } else if (node.declaration.type === 'VariableDeclaration') {
                        node.declaration.declarations.forEach((d: any) => exports.push(d.id.name));
                    }
                }
            },
            ExportDefaultDeclaration(node: any) {
                exports.push('default');
            }
        });
    } catch (e) {
        // Fallback or ignore parse error
    }

    return {
        path: filePath,
        exports,
        loc: code.split('\n').length
    };
}

function analyzeTestFile(filePath: string): TestStats {
    const code = fs.readFileSync(filePath, 'utf-8');
    const tests = (code.match(/test\(|it\(/g) || []).length;
    const suites = (code.match(/describe\(/g) || []).length;

    return {
        path: filePath,
        tests,
        suites
    };
}

async function runAudit() {
    console.log('🔍 Starting Coverage Audit...');

    const srcFiles = getAllFiles(SRC_DIR);
    const testFiles = getAllFiles(TEST_DIR);

    console.log(`Found ${srcFiles.length} source files.`);
    console.log(`Found ${testFiles.length} test files.`);

    const sourceStats = srcFiles.map(analyzeSourceFile);
    const testStats = testFiles.map(analyzeTestFile);

    const gaps: GapAnalysis[] = [];

    // Heuristic matching
    for (const src of sourceStats) {
        if (src.path.includes('src/test/')) continue; // Skip test tooling

        const relativePath = path.relative(SRC_DIR, src.path);
        const nameKeywords = path.basename(src.path, '.ts').split(/[-.]/);

        // Find matching tests
        const matchingTests = testStats.filter(t => {
            const tName = path.basename(t.path).toLowerCase();
            return nameKeywords.some(k => k.length > 3 && tName.includes(k.toLowerCase()));
        });

        const totalTests = matchingTests.reduce((acc, t) => acc + t.tests, 0);

        let status: 'MISSING' | 'PARTIAL' | 'COVERED' = 'MISSING';
        if (totalTests > 0) status = 'PARTIAL';
        if (totalTests >= src.exports.length && src.exports.length > 0) status = 'COVERED';
        if (src.exports.length === 0) status = 'COVERED'; // No exports to test

        gaps.push({
            file: relativePath,
            exportsContext: src.exports,
            potentialTests: matchingTests.map(t => path.relative(TEST_DIR, t.path)),
            status
        });
    }

    // Generate Report
    let report = `# Coverage Gap Analysis Report
**Generated**: ${new Date().toISOString()}
**Source Files**: ${srcFiles.length}
**Test Files**: ${testFiles.length}

## Summary
| Status | Files | Percentage |
| :--- | :--- | :--- |
| 🟢 COVERED | ${gaps.filter(g => g.status === 'COVERED').length} | ${Math.round(gaps.filter(g => g.status === 'COVERED').length / gaps.length * 100)}% |
| 🟡 PARTIAL | ${gaps.filter(g => g.status === 'PARTIAL').length} | ${Math.round(gaps.filter(g => g.status === 'PARTIAL').length / gaps.length * 100)}% |
| 🔴 MISSING | ${gaps.filter(g => g.status === 'MISSING').length} | ${Math.round(gaps.filter(g => g.status === 'MISSING').length / gaps.length * 100)}% |

## Detailed Breakdown

| Module / File | Status | Experts Detected | Matches Found |
| :--- | :--- | :--- | :--- |
`;

    for (const gap of gaps.sort((a, b) => a.status.localeCompare(b.status))) {
        const icon = gap.status === 'COVERED' ? '🟢' : gap.status === 'PARTIAL' ? '🟡' : '🔴';
        report += `| ${icon} \`${gap.file}\` | **${gap.status}** | ${gap.exportsContext.length} | ${gap.potentialTests.length > 0 ? gap.potentialTests.join('<br>') : 'None'} |\n`;
    }

    fs.writeFileSync(OUTPUT_FILE, report);
    console.log(`✅ Audit Complete. Report saved to ${OUTPUT_FILE}`);
}

runAudit();
