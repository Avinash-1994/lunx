/**
 * S2.2 — Secret Scanner
 * Scans all emitted bundle text for leaked secrets before writing dist/.
 * Runs as a Rust-speed regex pass over every output file's content.
 * NEVER prints the actual secret value.
 */
import fs from 'node:fs';
import path from 'node:path';
/** Default secret detection patterns (S2.2 spec) */
export const DEFAULT_SECRET_PATTERNS = [
    { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ }, // lunx-scan-ignore
    { name: 'Generic API Key', pattern: /(api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{20,}['"]/i },
    { name: 'RSA Private Key', pattern: /-----BEGIN RSA PRIVATE KEY-----/ }, // lunx-scan-ignore
    { name: 'EC Private Key', pattern: /-----BEGIN EC PRIVATE KEY-----/ }, // lunx-scan-ignore
    { name: 'OpenSSH Private Key', pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/ }, // lunx-scan-ignore
    { name: 'JWT Token', pattern: /eyJ[A-Za-z0-9-_=]{20,}\.[A-Za-z0-9-_=]{20,}\.?[A-Za-z0-9-_.+/=]*/ },
    { name: 'MongoDB URL', pattern: /mongodb:\/\/[^@\s]+@/ },
    { name: 'Postgres URL', pattern: /postgres:\/\/[^@\s]+@/ },
    { name: 'MySQL URL', pattern: /mysql:\/\/[^@\s]+@/ },
    { name: 'Redis URL', pattern: /redis:\/\/[^@\s]+@/ },
    { name: 'GitHub Token', pattern: /ghp_[A-Za-z0-9]{36}/ },
    { name: 'Stripe Live Key', pattern: /sk_live_[A-Za-z0-9]{24,}/ },
    { name: 'Stripe Test Key', pattern: /sk_test_[A-Za-z0-9]{24,}/ },
    { name: 'SendGrid Key', pattern: /SG\.[A-Za-z0-9]{22}\.[A-Za-z0-9]{43}/ },
];
/**
 * Scan output files for secrets before writing to dist/.
 * @param files – map of output filePath → fileContent
 * @param allowlist – regex patterns to skip (user-defined false-positive suppression)
 * @param logDir – directory to write secret-scan.log
 */
export function scanSecrets(files, allowlist = [], logDir) {
    const violations = [];
    for (const [filePath, content] of Object.entries(files)) {
        // Only scan JS/CSS/HTML text files
        const ext = path.extname(filePath).toLowerCase();
        if (!['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.ts'].includes(ext))
            continue;
        const lines = content.split('\n');
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            // Check allowlist first
            if (allowlist.some((r) => r.test(line)))
                continue;
            for (const { name, pattern } of DEFAULT_SECRET_PATTERNS) {
                if (pattern.test(line)) {
                    violations.push({
                        file: filePath,
                        patternName: name,
                        lineNumber: lineIdx + 1,
                    });
                    console.error(`\nSECURITY: Potential secret detected in bundle output.\n` +
                        `  File:    ${filePath}\n` +
                        `  Pattern: ${name}\n` +
                        `  Line:    ${lineIdx + 1} (value redacted)\n` +
                        `  This value should be an environment variable, not embedded in source code.`);
                }
            }
        }
    }
    // Write redacted log
    if (violations.length > 0 && logDir) {
        const logPath = path.join(logDir, 'secret-scan.log');
        fs.mkdirSync(logDir, { recursive: true });
        const logLines = violations.map((v) => `[${new Date().toISOString()}] ${v.patternName} in ${v.file}:${v.lineNumber} (value redacted)`);
        fs.appendFileSync(logPath, logLines.join('\n') + '\n', 'utf8');
    }
    return { clean: violations.length === 0, violations };
}
