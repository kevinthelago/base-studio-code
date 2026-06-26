// Typed data for the Skills library.
//
// A "skill" is a reusable capability bundle — a named procedure (prompt +
// bundled tools + guardrails) any worker running an allowed permission-profile
// can invoke. The packaged set ships compliance & standards procedures (SOC 2,
// GDPR, accessibility, i18n, …) — the cross-cutting obligations almost every
// product carries. Shaped to mirror the MCP catalog data model (see
// data/mcpCatalog.ts) so swapping in live data later is a drop-in. Stats are
// fleet-wide, last 7d.

/** Capability kind — drives the card glyph + accent color. */
export type SkillKind = "workflow" | "scaffold" | "codemod" | "review" | "docs";

/** Where a skill came from — drives its source tag style. */
export type SkillSource = "first-party" | "team" | "imported" | "community";

/** Permission profile a skill is allowed to run under (mirrors agentProfiles). */
export type SkillProfile = "build" | "review" | "docs" | "auto" | "sandbox";

export interface Skill {
  id: string;
  name: string;
  kind: SkillKind;
  source: SkillSource;
  desc: string;
  /** The full authored procedure (the SKILL.md body). When absent, the seeded
   *  SkillDef falls back to `desc`. Packaged skills carry a real procedure here. */
  body?: string;
  /** Tool names bundled with the skill, rendered as kbd chips. */
  tools: string[];
  /** Permission profiles allowed to invoke it. */
  profiles: SkillProfile[];
  /** Pinned skills are auto-available to the fleet. */
  pinned?: boolean;
  // ── display-only telemetry (optional — the packaged JSON data files drop these;
  //    real usage is supplied later from the skill-usage log, #406). ──
  /** Fleet-wide invocations over the last 7 days. */
  invocations?: number;
  /** Success rate (0–100), weighted into the KPIs. */
  success?: number;
  /** Average tokens per invocation, in thousands. */
  avgTokensK?: number;
  lastUsed?: string;
  /** 7-point trend used for the inline sparkline. */
  trend?: number[];
}

export interface KindMeta {
  label: string;
  glyph: string;
  /** CSS color (token var or oklch literal). */
  color: string;
}

export interface SourceTag {
  label: string;
  /** Tag CSS modifier class ("amber" | "info" | ""). */
  cls: string;
}

// Shared color literals (match the design palette).
const A = "var(--accent)";
const I = "var(--info)";
const G = "var(--success)";
const V = "oklch(0.7 0.12 290)";
const DOCSC = "oklch(0.7 0.06 90)";

/** kind → glyph + color (matches the catalog-icon style on the MCP screen). */
export const KIND: Record<SkillKind, KindMeta> = {
  workflow: { label: "workflow", glyph: "⌁", color: A },
  scaffold: { label: "scaffold", glyph: "▤", color: I },
  codemod:  { label: "codemod",  glyph: "↻", color: V },
  review:   { label: "review",   glyph: "◇", color: G },
  docs:     { label: "docs",     glyph: "¶", color: DOCSC },
};

/** profile keys mirror agentProfiles / fleet PROFILE. */
export const PROFILE_COLOR: Record<SkillProfile, string> = {
  build:   "oklch(0.78 0.14 70)",
  review:  "oklch(0.72 0.10 230)",
  docs:    "oklch(0.7 0.06 90)",
  auto:    "oklch(0.74 0.13 145)",
  sandbox: "oklch(0.68 0.18 25)",
};

export const SOURCE_TAG: Record<SkillSource, SourceTag> = {
  "first-party": { label: "first-party", cls: "amber" },
  team:          { label: "team",        cls: "info" },
  imported:      { label: "imported",    cls: "" },
  community:     { label: "community",    cls: "" },
};

// The packaged skills are compliance & standards procedures — the cross-cutting
// obligations (security attestation, data protection, accessibility, localization)
// that apply to nearly every product, so they ship enabled + global. Each carries
// a real authored `body` (the SKILL.md procedure) the fleet runs verbatim.
//
// They live as one JSON file per skill under `src-tauri/prompts/skills/` (#1715) — the SAME
// backend-owned data files the Rust `skilldb` crate embeds via `include_dir!` to seed a fresh
// skills.db, so the packaged set is defined ONCE and read by both consumers (mirrors how the
// built-in blueprints + stage directives already work). Keys are camelCase to parse identically
// on both sides. Telemetry fields are intentionally absent (zeroed downstream by `fromSample`).
const skillModules = import.meta.glob<{ default: Skill }>("@prompts/skills/*.json", { eager: true });

/** The packaged skill library, assembled from the per-skill JSON definitions (sorted by id for a
 *  stable order). */
export const SKILLS: Skill[] = Object.entries(skillModules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, m]) => m.default);

/** Compact number formatter (e.g. 1234 → "1.2k"). Single source: re-exports the chart `fmt`
 *  (#1528) so there's one impl. */
export { fmt as fmtCount } from "@/shared/ui/charts/primitives";
