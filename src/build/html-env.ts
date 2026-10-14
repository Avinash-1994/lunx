/**
 * `%NAME%` in HTML, as in Vite: any `import.meta.env` value (`%VITE_APP_TITLE%`,
 * `%MODE%`, `%BASE_URL%`…). Names that aren't defined stay as written, so
 * percent-encoding and literal percents are untouched.
 */
export function replaceHtmlEnv(html: string, env: Record<string, unknown>): string {
    if (!html.includes('%')) return html;
    return html.replace(/%(\w+)%/g, (match, name: string) =>
        Object.prototype.hasOwnProperty.call(env, name) && env[name] != null ? String(env[name]) : match,
    );
}

/** The `import.meta.env` object from an `'import.meta.env'` define (a JSON string). */
export function metaEnvFrom(defines: Record<string, string> | undefined): Record<string, unknown> {
    try {
        return JSON.parse(defines?.['import.meta.env'] ?? '{}');
    } catch {
        return {};
    }
}
