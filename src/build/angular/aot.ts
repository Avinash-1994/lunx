/**
 * Angular production builds compiled ahead of time, as `ng build` does:
 *
 *  - the app's sources go through @angular/compiler-cli (ngtsc), so templates
 *    become code and @angular/compiler (the runtime JIT compiler) is not shipped;
 *  - packages published in partial-compilation form (`ɵɵngDeclare…`) are
 *    finished by Angular's linker;
 *  - Angular's build optimizations (./optimize.ts) let unused components,
 *    services and metadata tree-shake away.
 *
 * Everything comes from the project's own @angular/compiler-cli (and the
 * @babel/core it depends on). Without it, lunx builds the app JIT, as before.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { adjustStaticMembers, adjustTypeScriptEnums, elideAngularMetadata, markTopLevelPure } from './optimize.js';

export interface AngularAot {
    /** The compiled module for one of the app's sources; undefined when the program did not include it. */
    output(file: string): { code: string; map: string | null } | undefined;
    /** Link and optimize a module from node_modules; null when there is nothing to do. */
    optimize(file: string, code: string): Promise<string | null>;
    flush(): Promise<void>;
    /** The globals Angular checks for dev mode, JIT, Closure i18n, SSR and HMR. */
    defines: Record<string, string>;
}

const DEFINES: Record<string, string> = {
    ngDevMode: 'false',
    ngJitMode: 'false',
    ngI18nClosureMode: 'false',
    ngServerMode: 'false',
    ngHmrMode: 'false',
};

export interface AngularAotOptions {
    root: string;
    /** The build's entry modules: they join the program even if the tsconfig leaves them out. */
    entries: string[];
    sourcemap: boolean;
    /** A component stylesheet (file, or inline with the given language) compiled to CSS. */
    compileStyle(file: string, source: string): Promise<string>;
    /** Keep linked / optimized packages on disk for the next build (default true). */
    cache?: boolean;
    /** Resolve `@angular/compiler-cli` from here (tests). */
    from?: string;
}

const real = (file: string): string => {
    try {
        return fs.realpathSync(file);
    } catch {
        return path.resolve(file);
    }
};

/** null when the project has no @angular/compiler-cli: the caller builds JIT. */
export async function prepareAngularAot(opts: AngularAotOptions): Promise<AngularAot | null> {
    const { root } = opts;
    const req = createRequire(path.join(opts.from ?? root, 'package.json'));
    let cliEntry: string;
    try {
        cliEntry = req.resolve('@angular/compiler-cli');
    } catch {
        return null;
    }
    const ngc = await import(pathToFileURL(cliEntry).href);
    const cliRequire = createRequire(cliEntry);
    const ts = cliRequire('typescript');
    const [{ needsLinking }, linkerModule] = await Promise.all([
        import(pathToFileURL(cliRequire.resolve('@angular/compiler-cli/linker')).href),
        import(pathToFileURL(cliRequire.resolve('@angular/compiler-cli/linker/babel')).href),
    ]);
    const linker = linkerModule.default ?? linkerModule;
    const babel = cliRequire('@babel/core');
    const cliVersion: string = JSON.parse(fs.readFileSync(path.join(path.dirname(cliRequire.resolve('@angular/compiler-cli/package.json')), 'package.json'), 'utf8')).version;

    const outputs = await compileApp(ngc, ts, opts);

    const { TransformCache } = await import('../build-cache.js');
    const cache = opts.cache === false ? null : new TransformCache(root, 'angular', `${cliVersion}\0${babel.version}`);
    const sideEffectsOf = packageSideEffects();
    return {
        output: (file) => outputs.get(real(file)),
        async optimize(file, code) {
            const link = requiresLinking(file, code, needsLinking);
            // Angular's packages and libraries built for Angular; others gain nothing.
            const angular = /[\\/]node_modules[\\/]@angular[\\/]/.test(file) || code.includes('ɵ') || code.includes('InjectionToken');
            if (!link && !angular) return null;
            const parts = [file, code];
            const hit = await cache?.get(parts);
            if (hit) return hit as string;
            const sideEffectFree = sideEffectsOf(file) === false;
            const safeAngularPackage = sideEffectFree && /[\\/]node_modules[\\/]@angular[\\/]/.test(file);
            const plugins: any[] = [];
            if (link) plugins.push(linker);
            plugins.push(
                [markTopLevelPure, { topLevelSafeMode: !safeAngularPackage }],
                elideAngularMetadata,
                adjustTypeScriptEnums,
                [adjustStaticMembers, { wrapDecorators: sideEffectFree }],
            );
            const result = await babel.transformAsync(code, {
                filename: file,
                plugins,
                compact: false,
                babelrc: false,
                configFile: false,
                browserslistConfigFile: false,
                sourceMaps: false,
                inputSourceMap: false,
            });
            const out = result?.code ?? code;
            await cache?.set(parts, out);
            return out;
        },
        flush: async () => cache?.flush(),
        defines: DEFINES,
    };
}

/** @angular/core and @angular/compiler mention the declare functions without needing the linker. */
function requiresLinking(file: string, code: string, needsLinking: (file: string, code: string) => boolean): boolean {
    if (/[\\/]@angular[\\/](?:compiler|core)[\\/]|\.tsx?$/.test(file)) return false;
    return needsLinking(file, code);
}

/** The app through ngtsc: compiled module per source file. */
async function compileApp(ngc: any, ts: any, opts: AngularAotOptions): Promise<Map<string, { code: string; map: string | null }>> {
    const { root } = opts;
    const tsconfig = ['tsconfig.app.json', 'tsconfig.json'].map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
    const config = tsconfig
        ? ngc.readConfiguration(tsconfig)
        : { options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, experimentalDecorators: true, skipLibCheck: true }, rootNames: [], errors: [] };
    const configErrors = (config.errors ?? []).filter((d: any) => d.category === ts.DiagnosticCategory.Error);
    if (configErrors.length) throw new Error(formatDiagnostics(ts, configErrors, root));

    const options = {
        ...config.options,
        // As the Angular CLI sets them for a browser build.
        noEmit: false,
        noEmitOnError: false,
        emitDeclarationOnly: false,
        declaration: false,
        declarationMap: false,
        composite: false,
        incremental: false,
        tsBuildInfoFile: undefined,
        outDir: undefined,
        outFile: undefined,
        suppressOutputPathCheck: true,
        sourceMap: opts.sourcemap,
        inlineSourceMap: false,
        inlineSources: opts.sourcemap,
        mapRoot: undefined,
        sourceRoot: undefined,
        compilationMode: 'full',
        allowEmptyCodegenFiles: false,
        annotationsAs: 'decorators',
        enableResourceInlining: false,
        supportTestBed: false,
        supportJitMode: false,
    };
    if (options.target === undefined || options.target < ts.ScriptTarget.ES2022) options.target = ts.ScriptTarget.ES2022;
    if (options.useDefineForClassFields === undefined) options.useDefineForClassFields = false;
    if (options.module === undefined || options.module < ts.ModuleKind.ES2015 || options.module === ts.ModuleKind.Node16 || options.module === ts.ModuleKind.NodeNext) {
        options.module = ts.ModuleKind.ESNext;
    }

    const host = ts.createCompilerHost(options);
    const outputs = new Map<string, { code: string; map: string | null }>();
    const maps = new Map<string, string>();
    host.writeFile = (fileName: string, data: string, _bom: boolean, _onError: unknown, sourceFiles?: readonly any[]) => {
        const source = sourceFiles?.[0]?.fileName;
        if (!source) return;
        const key = real(source);
        if (fileName.endsWith('.js.map')) maps.set(key, data);
        else if (/\.[mc]?js$/.test(fileName)) outputs.set(key, { code: data.replace(/^\/\/# sourceMappingURL=.*$/m, ''), map: null });
    };
    host.readResource = (file: string) => fs.readFileSync(file, 'utf8');
    host.transformResource = async (data: string, context: { type: string; containingFile: string; resourceFile: string | null }) => {
        if (context.type !== 'style') return null;
        // An inline style is in the component's `inlineStyleLanguage` (CSS unless set).
        const lang = options.inlineStyleLanguage ?? 'css';
        const file = context.resourceFile ?? context.containingFile.replace(/\.[^./\\]+$/, `.ng-inline.${lang}`);
        return { content: await opts.compileStyle(file, data) };
    };

    const rootNames = [...new Set([...config.rootNames, ...opts.entries.filter((f) => /\.[mc]?tsx?$/.test(f))])];
    const program = new ngc.NgtscProgram(rootNames, options, host);
    await program.loadNgStructureAsync();
    const errors = [
        ...program.getTsOptionDiagnostics(),
        ...program.getNgOptionDiagnostics(),
        ...program.getTsSyntacticDiagnostics(),
        ...program.getNgStructuralDiagnostics(),
    ].filter((d: any) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(formatDiagnostics(ts, errors, root));
    program.emit();
    for (const [file, map] of maps) {
        const out = outputs.get(file);
        if (out) out.map = map;
    }
    // The app's AOT code never calls the JIT compiler; the import (needed in dev) would ship it.
    for (const out of outputs.values()) out.code = out.code.replace(/^import ['"]@angular\/compiler['"];?[ \t]*$/m, '');
    return outputs;
}

function formatDiagnostics(ts: any, diagnostics: readonly any[], root: string): string {
    return `Angular compilation failed:\n${ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (f: string) => f,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
    })}`;
}

/** Each module's package.json `sideEffects` (false, true, or undefined when the package does not say). */
function packageSideEffects(): (file: string) => boolean | undefined {
    const byDir = new Map<string, boolean | undefined>();
    return (file) => {
        let dir = path.dirname(file);
        const seen: string[] = [];
        let value: boolean | undefined;
        for (;;) {
            if (byDir.has(dir)) {
                value = byDir.get(dir);
                break;
            }
            seen.push(dir);
            const manifest = path.join(dir, 'package.json');
            let pkg: any = null;
            try {
                pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
            } catch {
                // not a package root
            }
            if (pkg?.name) {
                value = pkg.sideEffects === false ? false : pkg.sideEffects === undefined ? undefined : true;
                break;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        for (const d of seen) byDir.set(d, value);
        return value;
    };
}
