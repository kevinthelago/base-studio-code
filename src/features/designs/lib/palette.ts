// The theme try-on palette strip's model (#2834) — the semantic base-palette tokens a theme retints,
// grouped for display (surfaces · text · borders · accent · status). These are exactly the keys every
// packaged palette theme overrides; the strip shows each as the theme's override value when set, else
// the live base token default. Pure (React-free) → unit-testable.

export interface PaletteToken {
  /** Short display name under the swatch. */
  name: string;
  /** The CSS custom property the swatch reflects. */
  token: string;
}

export interface PaletteGroup {
  label: string;
  tokens: PaletteToken[];
}

/** The semantic palette, grouped — the 14 base-palette tokens every packaged theme retints. */
export const PALETTE_GROUPS: PaletteGroup[] = [
  { label: "Surfaces", tokens: [
    { name: "canvas", token: "--bg-canvas" },
    { name: "panel", token: "--bg-panel" },
    { name: "elev", token: "--bg-elev" },
    { name: "elev2", token: "--bg-elev2" },
  ] },
  { label: "Text", tokens: [
    { name: "fg", token: "--fg" },
    { name: "muted", token: "--fg-muted" },
    { name: "dim", token: "--fg-dim" },
  ] },
  { label: "Borders", tokens: [
    { name: "border", token: "--border" },
    { name: "soft", token: "--border-soft" },
  ] },
  { label: "Accent", tokens: [
    { name: "accent", token: "--accent" },
    { name: "dim", token: "--accent-dim" },
  ] },
  { label: "Status", tokens: [
    { name: "success", token: "--success" },
    { name: "info", token: "--info" },
    { name: "danger", token: "--danger" },
  ] },
];

/** The swatch colour for a token under a theme: the theme's literal override if it sets it, else the
 *  live base token via `var()` (so a base-look theme with no overrides shows the app defaults). */
export function swatchColor(vars: Record<string, string>, token: string): string {
  return vars[token] ?? `var(${token})`;
}
