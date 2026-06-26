// Blueprints-page registry layer (#609) — the editor's palette metadata. The per-stage
// metadata (icon + hue + title + blurb) is single-sourced from the stage's own JSON in
// the prompts data layer (#1603): real stages carry `icon`/`hue` on their SECTION_DEF, and
// the discovery dimensions that double as palette kinds carry them on `discovery.json`'s
// `dimensions`. STAGE_KINDS is DERIVED from those here — no hand-maintained duplicate. Pure;
// the editor reads this for glyphs/hues/blurbs/dispositions; the runtime (#584 gateRule/
// stageStatus) is unchanged.

import { STAGE_DEFS } from "../stages/blueprints";

// ── hue helpers (oklch accents; share L/C, vary hue) ──────────────────────────
export const hue = (h: number): string => `oklch(0.74 0.11 ${h})`;
export const tint = (h: number, a: number): string => `oklch(0.74 0.11 ${h} / ${a})`;

// ── stage kinds: the palette of stages a blueprint can contain ────────────────
// `glyph` is the Material/Lucide icon name (for the editor `<Ic>`); `h` is the accent hue.
interface StageKindMeta { title: string; glyph: string; h: number; blurb: string }

/** Built at load from the stage JSON data layer: every real stage (a SECTION_DEF with an
 *  `icon`/`hue`) + every discovery dimension that doubles as a palette kind (an enriched
 *  `discovery.json` dimension). A stage's title/blurb come from its `name`/`blurb`, so the
 *  palette stays consistent with the stage bar (#1603 reconciled the former divergences). */
function buildStageKinds(): Record<string, StageKindMeta> {
  const out: Record<string, StageKindMeta> = {};
  for (const [key, def] of Object.entries(STAGE_DEFS)) {
    if (def.icon && typeof def.hue === "number") {
      out[key] = { title: def.name, glyph: def.icon, h: def.hue, blurb: def.blurb };
    }
  }
  for (const dim of STAGE_DEFS.discovery?.dimensions ?? []) {
    if (dim.icon && typeof dim.hue === "number") {
      out[dim.key] = { title: dim.title, glyph: dim.icon, h: dim.hue, blurb: dim.blurb ?? "" };
    }
  }
  return out;
}

export const STAGE_KINDS: Record<string, StageKindMeta> = buildStageKinds();

export function stageKind(key: string): StageKindMeta {
  return STAGE_KINDS[key] ?? { title: key, glyph: "category", h: 250, blurb: "" };
}

/** The kinds offered in the editor's "add stage" palette — a CURATED subset of {@link STAGE_KINDS},
 *  NOT every entry. The map now also carries icon/metadata for stages that arrive via blueprints or
 *  STAGE_DEFS but aren't hand-addable (the data-platform pipeline stages, the lifecycle stages
 *  seeded by their category's built-in, and the blueprint-authoring meta-stages), so an imported
 *  blueprint resolves a real icon for every stage without those flooding the palette. */
export const STAGE_KIND_KEYS = [
  "discovery", "repos", "users", "ui", "stack", "architecture", "schema", "api",
  "structure", "permissions", "automations", "skills", "testing", "security",
  "observability", "infra", "cicd", "docs", "cleanup",
];

// ── output dispositions: what happens to a stage's artifact ───────────────────
interface DispositionMeta { title: string; glyph: string; h: number; desc: string }

export const DISPOSITIONS: Record<string, DispositionMeta> = {
  "plan-file":  { title: "Plan file",       glyph: "description", h: 70,  desc: "Written to the plan directory." },
  issues:       { title: "GitHub issues",   glyph: "task_alt",    h: 230, desc: "Published as tracked issues." },
  milestones:   { title: "Milestones",      glyph: "flag",        h: 295, desc: "Synced to repo milestones." },
  "skill-index":{ title: "Skill index",     glyph: "extension",   h: 70,  desc: "Upserted into Skills library." },
  knowledge:    { title: "Knowledge store", glyph: "psychology",  h: 195, desc: "Injected into agent prompts." },
  scratch:      { title: "Scratch",         glyph: "edit_note",   h: 250, desc: "Working note — not published." },
};
export const DISPOSITION_KEYS = Object.keys(DISPOSITIONS);

/** Default disposition for a stage kind. */
export function defaultDisposition(key: string): string {
  if (key === "structure") return "issues";
  if (key === "skills") return "skill-index";
  if (key === "permissions" || key === "discovery") return "knowledge";
  return "plan-file";
}

// ── import source (#923) ──
// The import screen pulls real blueprint gists from a source GitHub account; the mock community
// catalog (+ its preview/fork flow) was removed. Configurable sources land later (#598). For now
// the default source is the maintainer's account.
export const DEFAULT_GIST_SOURCE = "kevinthelago";

/** Whether an imported blueprint is OUT OF DATE with its upstream gist (#955): the gist's current
 *  `updated_at` is strictly newer than the one recorded locally at import/sync. Both are GitHub
 *  `updated_at` timestamps. Unknown on either side ⇒ can't tell ⇒ not stale (treat as current).
 *  Drives whether the import page renders an "Update" button instead of "✓ Imported". */
export function gistUpdateAvailable(currentUpdatedAt?: string, importedUpdatedAt?: string): boolean {
  if (!currentUpdatedAt || !importedUpdatedAt) return false;
  const cur = new Date(currentUpdatedAt).getTime();
  const imp = new Date(importedUpdatedAt).getTime();
  return isFinite(cur) && isFinite(imp) && cur > imp;
}
