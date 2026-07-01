// Shared inline-style factories for the Skills screen (#1706). Pulled out of SkillsWorkspace.tsx so
// the screen, the view-mode renderers (SkillsViews.tsx), and the edit drawer all share one source
// of the pill / tile / scope-color styling. Pure CSSProperties builders (the only React coupling is
// the type import).

import type { CSSProperties } from "react";
import { KIND, type SkillKind, type SkillSource } from "@/shared/data/skills";

/** Success-rate → color: dim when unknown, success/accent/danger by threshold. */
export const successColor = (s: number | null): string =>
  s == null ? "var(--fg-dim)" : s >= 95 ? "var(--success)" : s >= 85 ? "var(--accent)" : "var(--danger)";

/** A translucent tint of `hue` (a `--token` ref or oklch literal). */
export function tintBg(hue: string, t = 88): string { return `color-mix(in oklch, ${hue}, transparent ${t}%)`; }

/** A small pill chip in `hue` (or a neutral "plain" chip). */
export function pill(hue: string, plain = false): CSSProperties {
  const base: CSSProperties = { fontFamily: "var(--mono)", fontSize: 9.5, padding: "2px 7px", borderRadius: 99, lineHeight: 1.1, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center" };
  if (plain) return { ...base, background: tintBg("var(--fg-dim)"), border: "1px solid " + tintBg("var(--fg-dim)", 80), color: "var(--fg-muted)" };
  return { ...base, background: tintBg(hue), border: `1px solid ${tintBg(hue, 74)}`, color: hue };
}

/** A square glyph tile in an arbitrary hue (a `--token` ref or oklch literal). */
export function hueTile(c: string, lg = false): CSSProperties {
  const d = lg ? 30 : 22;
  return { width: d, height: d, flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, fontFamily: "var(--mono)", fontSize: lg ? 15 : 12, color: c, background: `color-mix(in oklch, ${c} 22%, var(--bg-elev))`, border: `1px solid ${tintBg(c, 70)}` };
}

/** A glyph tile colored by the skill kind. */
export function glyphTile(kind: SkillKind, lg = false): CSSProperties {
  return hueTile(KIND[kind].color, lg);
}

/** Source pill: info for team, accent for imported, neutral otherwise. */
export const sourcePill = (src: SkillSource): CSSProperties =>
  src === "team" ? pill("var(--info)") : src === "imported" ? pill("var(--accent)") : pill("", true);

/** Scope pill: info when project-scoped, neutral when global. */
export const scopePill = (projects: string[]): CSSProperties => (projects.length ? pill("var(--info)") : pill("", true));
