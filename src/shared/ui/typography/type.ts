// type.ts — the shared vocabulary the Text primitive is built on (#2057).
//
// One type scale, one semantic tone mapping. The named `TextSize` rungs mirror the `--fs-*` CSS
// tokens in tokens.css (xxs=9 … xl=18) so the primitive and the stylesheet speak the same scale —
// chosen from the real fontSize distribution (11/10/12/14/18 dominate). But a raw pixel number is
// always legal too (the off-scale half-sizes 9.5/10.5/11.5/13 stay `size={10.5}`), which keeps
// mechanical `<span style={{ fontSize }}>` → primitive conversions lossless.

/** A font size: a named scale rung, or a raw pixel number for the off-scale cases. */
export type TextSize = number | "xxs" | "xs" | "sm" | "md" | "lg" | "xl";

/** A semantic tone: maps to a foreground color token. Omit to inherit (no color forced). */
export type Tone = "dim" | "muted" | "accent" | "danger" | "success";

const SCALE: Record<Exclude<TextSize, number>, number> = { xxs: 9, xs: 10, sm: 11, md: 12, lg: 14, xl: 18 };

const TONE: Record<Tone, string> = {
  dim: "var(--fg-dim)",
  muted: "var(--fg-muted)",
  accent: "var(--accent)",
  danger: "var(--danger)",
  success: "var(--success)",
};

/** Resolve a `TextSize` to a pixel number (named rung → scale, number → itself). */
export function fontSize(v: TextSize | undefined): number | undefined {
  if (v == null) return undefined;
  return typeof v === "number" ? v : SCALE[v];
}

/** Resolve a semantic `Tone` to its color token (undefined → inherit, no color set). */
export function toneColor(v: Tone | undefined): string | undefined {
  return v == null ? undefined : TONE[v];
}
