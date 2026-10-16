/**
 * Types for what lunx gives modules in dev and in the build. In a TypeScript
 * project: `"types": ["lunx-dev/client"]` in tsconfig.json, or
 * `/// <reference types="lunx-dev/client" />` in a `.d.ts` file.
 */

interface ImportMetaEnv {
    /** `development`, `production` or `test`. */
    readonly MODE: string;
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly SSR: boolean;
    /** The public base the app is served from (`/`, `./`, `/my-app/`). */
    readonly BASE_URL: string;
    /** `LUNX_*`, `VITE_*`, `PUBLIC_*` and `REACT_APP_*` variables from the environment and `.env` files. */
    readonly [key: string]: string | boolean | undefined;
}

interface LunxHotContext {
    readonly data: Record<string, any>;
    accept(): void;
    accept(cb: (mod: any) => void): void;
    accept(dep: string, cb: (mod: any) => void): void;
    accept(deps: readonly string[], cb: (mods: any[]) => void): void;
    dispose(cb: (data: Record<string, any>) => void): void;
    prune(cb: (data: Record<string, any>) => void): void;
    decline(): void;
    invalidate(message?: string): void;
    on(event: string, cb: (payload: any) => void): void;
    off(event: string, cb: (payload: any) => void): void;
    send(event: string, data?: any): void;
}

interface ImportGlobOptions {
    eager?: boolean;
    import?: string;
    query?: string | Record<string, string | number | boolean>;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
    /** In dev only: `if (import.meta.hot) { … }`. */
    readonly hot?: LunxHotContext;
    glob<T = any>(pattern: string | readonly string[], options?: ImportGlobOptions & { eager?: false }): Record<string, () => Promise<T>>;
    glob<T = any>(pattern: string | readonly string[], options: ImportGlobOptions & { eager: true }): Record<string, T>;
}

// ── Stylesheets ──────────────────────────────────────────────────────────────

declare module '*.module.css' {
    const classes: Readonly<Record<string, string>>;
    export default classes;
}
declare module '*.module.scss' {
    const classes: Readonly<Record<string, string>>;
    export default classes;
}
declare module '*.module.sass' {
    const classes: Readonly<Record<string, string>>;
    export default classes;
}
declare module '*.module.less' {
    const classes: Readonly<Record<string, string>>;
    export default classes;
}
declare module '*.module.styl' {
    const classes: Readonly<Record<string, string>>;
    export default classes;
}

// ── Assets: their URL ────────────────────────────────────────────────────────

declare module '*.svg' { const src: string; export default src; }
declare module '*.png' { const src: string; export default src; }
declare module '*.jpg' { const src: string; export default src; }
declare module '*.jpeg' { const src: string; export default src; }
declare module '*.gif' { const src: string; export default src; }
declare module '*.webp' { const src: string; export default src; }
declare module '*.avif' { const src: string; export default src; }
declare module '*.ico' { const src: string; export default src; }
declare module '*.bmp' { const src: string; export default src; }
declare module '*.woff' { const src: string; export default src; }
declare module '*.woff2' { const src: string; export default src; }
declare module '*.ttf' { const src: string; export default src; }
declare module '*.otf' { const src: string; export default src; }
declare module '*.eot' { const src: string; export default src; }
declare module '*.mp4' { const src: string; export default src; }
declare module '*.webm' { const src: string; export default src; }
declare module '*.ogg' { const src: string; export default src; }
declare module '*.mp3' { const src: string; export default src; }
declare module '*.wav' { const src: string; export default src; }
declare module '*.flac' { const src: string; export default src; }
declare module '*.aac' { const src: string; export default src; }
declare module '*.m4a' { const src: string; export default src; }
declare module '*.pdf' { const src: string; export default src; }
declare module '*.txt' { const src: string; export default src; }
declare module '*.wasm' { const src: string; export default src; }

// ── Queries ──────────────────────────────────────────────────────────────────

declare module '*?url' { const url: string; export default url; }
declare module '*?raw' { const content: string; export default content; }
declare module '*?inline' { const content: string; export default content; }

/** `import init from './module.wasm?init'`: `await init(imports)` is the instance. */
declare module '*.wasm?init' {
    const init: (imports?: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
    export default init;
}

/** An SVG file as a React (or Preact) component; props override the root `<svg>`'s attributes. */
declare module '*.svg?react' {
    import type { FunctionComponent, SVGProps, RefAttributes } from 'react';
    const Component: FunctionComponent<SVGProps<SVGSVGElement> & RefAttributes<SVGSVGElement>>;
    export default Component;
}

/** An SVG file as a component of the app's framework (React, Preact, Vue). */
declare module '*.svg?component' {
    const Component: any;
    export default Component;
}
