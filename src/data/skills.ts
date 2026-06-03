// Display metadata + the seed library for the Skills screen.
//
// The screen renders entirely off the live store (`skills: SkillDef[]`, seeded from
// SEED_SKILLS below) and off the real usage log (lib/skillTelemetry) — there is NO
// fabricated invocation data here. Per #406 the dashboard starts quiet and real
// usage fills the metrics in. This file holds only static presentation maps, the
// "Add a skill" catalog, and the initial library the store seeds from.

import { defFromCatalog, type SkillDef, type SkillKind, type SkillProfile } from "../lib/skills";

/** Per-kind display metadata: a short label, a glyph, and an accent class. */
export const KIND_META: Record<SkillKind, { label: string; icon: string; tone: string }> = {
  workflow: { label: "workflow", icon: "⚙", tone: "info" },
  scaffold: { label: "scaffold", icon: "▤", tone: "green" },
  codemod:  { label: "codemod",  icon: "↻", tone: "violet" },
  review:   { label: "review",   icon: "✓", tone: "amber" },
  docs:     { label: "docs",     icon: "¶", tone: "muted" },
};

/** Per-profile dot color (oklch), shown as the profile-guardrail dots on a card. */
export const PROFILE_META: Record<SkillProfile, { label: string; color: string }> = {
  build:   { label: "build",   color: "oklch(0.74 0.13 145)" },
  review:  { label: "review",  color: "oklch(0.78 0.13 70)" },
  docs:    { label: "docs",    color: "oklch(0.72 0.10 230)" },
  auto:    { label: "auto",    color: "oklch(0.78 0.10 320)" },
  sandbox: { label: "sandbox", color: "oklch(0.66 0.05 260)" },
};

export interface CatalogItem {
  name: string;
  by: string;
  /** A short glyph for the catalog tile. */
  icon: string;
  desc: string;
}

/** The "Add a skill" catalog — one-click installs that expand (via `defFromCatalog`)
 *  into a fully-populated skill (prompt, tools, profiles). */
export const SKILL_CATALOG: CatalogItem[] = [
  { name: "Open a clean PR",          by: "first-party", icon: "⤴", desc: "Conventional-commit title, summary + test plan from the diff, links the issue, requests review." },
  { name: "Scaffold a Tauri command", by: "first-party", icon: "▤", desc: "Adds a #[tauri::command], wires the invoke handler, generates the TS binding, stubs a test." },
  { name: "Triage a failing test",    by: "first-party", icon: "✓", desc: "Reproduces, bisects the offending change, proposes a minimal fix, re-runs the suite." },
  { name: "Project-wide rename",      by: "first-party", icon: "↻", desc: "Type-aware symbol rename across Rust + TS; updates imports + call-sites; typecheck-verified." },
  { name: "Security review pass",     by: "first-party", icon: "⊘", desc: "Read-only sweep for secrets, unsafe blocks, missing auth, injection sinks — comments only." },
  { name: "Generate API docs",        by: "first-party", icon: "¶", desc: "Derives reference docs + a changelog entry from a merged contract; opens a docs-only PR." },
];

/** A stable seed id so the initial library is deterministic across reloads (before
 *  the user mutates it and persistence takes over). */
function seedId(name: string): string {
  return "skill_seed_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * The library the store seeds from on first run — the first-party catalog expanded
 * into full {@link SkillDef}s (enabled + pinned + global). Carries no usage metrics;
 * those derive from the real log (#406).
 */
export const SEED_SKILLS: SkillDef[] = SKILL_CATALOG.map(c => ({
  ...defFromCatalog(c.name),
  id: seedId(c.name),
}));
