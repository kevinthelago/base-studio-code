// Appearance prefs that drive the design-token CSS variables at runtime (#486).
//
// The accent is a single hue threaded through two tokens — `--accent` (the bright
// interactive color) and `--accent-dim` (its muted partner) — which the rest of
// the palette derives from via color-mix. Offering a fixed set of hue presets (vs.
// a freeform picker) keeps the two tokens in lockstep at the lightness/chroma the
// design was tuned for, so every accent stays legible.
//
// Pure (no DOM access) so the mapping is unit-testable; the App applies the result
// to document.documentElement.

export interface AccentPreset {
  /** Stable id persisted in the store. */
  id: string;
  /** Label shown in the Appearance picker. */
  label: string;
  /** oklch hue angle for this accent. */
  hue: number;
}

/** The accent palette. `amber` (hue 70) is the historical default in tokens.css. */
export const ACCENT_PRESETS: AccentPreset[] = [
  { id: "amber",  label: "Amber",  hue: 70  },
  { id: "blue",   label: "Blue",   hue: 230 },
  { id: "green",  label: "Green",  hue: 145 },
  { id: "cyan",   label: "Cyan",   hue: 195 },
  { id: "purple", label: "Purple", hue: 300 },
  { id: "red",    label: "Red",    hue: 25  },
];

export const DEFAULT_ACCENT = "amber";

/** The two `--accent*` token values for an accent id. Lightness/chroma match the
 *  tokens.css defaults so only the hue changes; an unknown id falls back to the
 *  default so a corrupt persisted value can't blank the accent. */
export function accentVars(id: string): { accent: string; accentDim: string } {
  const p = ACCENT_PRESETS.find((x) => x.id === id)
    ?? ACCENT_PRESETS.find((x) => x.id === DEFAULT_ACCENT)!;
  return {
    accent: `oklch(0.80 0.14 ${p.hue})`,
    accentDim: `oklch(0.55 0.10 ${p.hue})`,
  };
}
