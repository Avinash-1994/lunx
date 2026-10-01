
/**
 * Create-Nuclie CLI
 * Generates projects for 12 frameworks in <30s
 * Day 17: Create-Nuclie Templates Lock
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { TEMPLATES } from '../utils/templates.js';
import { red, green, blue, bold } from '../internal/colors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read real nuclie version from its own package.json
function getNuclieVersion(): string {
    try {
        const pkgPath = path.resolve(__dirname, '../../package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return `^${pkg.version}`;
    } catch { return 'latest'; }
}

async function main() {
    const args = process.argv.slice(2);
    let projectName = args[0];

    // Ignore 'bootstrap' or 'init' keyword if it's the first arg
    if (projectName === 'bootstrap' || projectName === 'init' || projectName === 'create') {
        projectName = args[1];
    }

    // Check for --name flag
    const nameIndexRange = args.indexOf('--name');
    if (nameIndexRange > -1) {
        projectName = args[nameIndexRange + 1];
    }

    let templateName = args.indexOf('--template') > -1 ? args[args.indexOf('--template') + 1] : null;

    if (!projectName || projectName.startsWith('--')) {
        console.error(red('Please specify project name: create-nuclie <name> or --name <name>'));
        process.exit(1);
    }

    if (!templateName) {
        console.log(blue('Available templates:'));
        Object.keys(TEMPLATES).forEach(t => console.log(`- ${t}`));
        console.error(red('Please specify template: --template <name>'));
        process.exit(1);
    }

    const template = TEMPLATES[templateName];
    if (!template) {
        console.error(red(`Unknown template: ${templateName}`));
        process.exit(1);
    }

    const targetDir = path.resolve(process.cwd(), projectName);
    if (fs.existsSync(targetDir)) {
        console.error(red(`Target directory ${projectName} already exists`));
        process.exit(1);
    }

    console.log(blue(`\n🚀 Scaffolding ${bold(template.name)} project in ${bold(projectName)}...`));

    // 1. Create Dir
    fs.mkdirSync(targetDir, { recursive: true });

    // 2. Create Files (replace version placeholder with real version)
    const nuclieVersion = getNuclieVersion();
    const versionLabel = nuclieVersion.replace('^', '');
    for (const file of template.files) {
        const filePath = path.join(targetDir, file.path);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const content = file.content.replace(/\{\{NUCLIE_VERSION\}\}/g, versionLabel);
        fs.writeFileSync(filePath, content);
    }

    // 3. Create package.json
    const pkg = {
        name: projectName,
        version: '0.0.0',
        type: 'module',
        scripts: {
            "dev": "nuclie dev",
            "build": "nuclie build",
            "preview": "nuclie preview"
        },
        dependencies: template.dependencies,
        devDependencies: {
            ...template.devDependencies,
            "nuclie": nuclieVersion
        }
    };
    fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(pkg, null, 2));

    console.log(green(`\n✅ Done. Now run:\n`));
    console.log(`  cd ${projectName}`);
    console.log(`  npm install`);
    console.log(`  npm run dev\n`);
}

// Only run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(err => console.error(err));
}

export { main }; // For testing
