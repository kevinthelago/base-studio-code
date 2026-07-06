// `{{NAME}}` placeholder filling for `@data`-seeded prompt templates (#2416). The prompt PROSE lives
// in JSON under `src-tauri/data/` (editable without a rebuild via the config-dir overlay, #2047);
// TS keeps only the interpolation — this helper is that interpolation step.

/**
 * Substitute every `{{NAME}}` placeholder in `template` with `vars[NAME]`.
 *
 * Uses a replacer FUNCTION (not a replacement string), so `$`-sequences in a value are inserted
 * verbatim rather than interpreted as regex replacement patterns. A placeholder with no entry in
 * `vars` is left untouched — a visible `{{…}}` in rendered output beats silently dropping prose,
 * and callers that must guarantee full substitution can assert on it.
 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}
