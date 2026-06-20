// Blueprints-page registry layer (#609) — the editor's palette metadata, ported from
// the design (design/base-studio-code-blueprints/js/data.jsx) and reconciled with our
// runtime model: stage keys match ours (`ui`, not the design's `ux`). Pure; the editor
// reads this for glyphs/hues/blurbs/dispositions; the runtime (#584 gateRule/sectionStatus)
// is unchanged.

// ── hue helpers (oklch accents; share L/C, vary hue) ──────────────────────────
export const hue = (h: number): string => `oklch(0.74 0.11 ${h})`;
export const tint = (h: number, a: number): string => `oklch(0.74 0.11 ${h} / ${a})`;

// ── stage kinds: the palette of stages a blueprint can contain ────────────────
export interface StageKindMeta { title: string; glyph: string; h: number; blurb: string }

export const STAGE_KINDS: Record<string, StageKindMeta> = {
  context:       { title: "Context",          glyph: "flag",            h: 70,  blurb: "Pitch, goals & house rules the agents read first." },
  repos:         { title: "Repositories",     glyph: "account_tree",    h: 230, blurb: "Which repos this project spans + linking." },
  users:         { title: "Users & personas", glyph: "group",           h: 295, blurb: "Who it's for and the jobs they need done." },
  ui:            { title: "UI design",        glyph: "design_services", h: 350, blurb: "Screen skeletons & flows — feeds render-preview." },
  stack:         { title: "Tech stack",       glyph: "layers",          h: 195, blurb: "Languages, frameworks & runtime choices." },
  architecture:  { title: "Architecture",     glyph: "hub",             h: 230, blurb: "Services, boundaries & how pieces fit." },
  schema:        { title: "Data model",       glyph: "database",        h: 145, blurb: "Entities, relations & migrations." },
  api:           { title: "API & contracts",  glyph: "api",             h: 195, blurb: "Endpoints & interface contracts." },
  structure:     { title: "Structure",        glyph: "checklist",       h: 70,  blurb: "Milestones, issues & stream labels." },
  permissions:   { title: "Permissions",      glyph: "key",             h: 25,  blurb: "Per-capability posture for each agent." },
  automations:   { title: "Automations",      glyph: "bolt",            h: 145, blurb: "Cron jobs & knowledge injections." },
  skills:        { title: "Skills",           glyph: "extension",       h: 70,  blurb: "Reusable capability bundles to index." },
  testing:       { title: "Testing",          glyph: "science",         h: 145, blurb: "Test strategy & coverage gates." },
  security:      { title: "Security",         glyph: "security",        h: 25,  blurb: "Threat model, secrets & access review." },
  observability: { title: "Observability",    glyph: "monitoring",      h: 230, blurb: "Logging, metrics & tracing plan." },
  infra:         { title: "Infrastructure",   glyph: "dns",             h: 295, blurb: "Hosting, environments & provisioning." },
  cicd:          { title: "CI/CD",            glyph: "deployed_code",   h: 195, blurb: "Build, test & release pipelines." },
  docs:          { title: "Documentation",    glyph: "menu_book",       h: 70,  blurb: "READMEs, guides & reference docs." },
  cleanup:       { title: "Dead & legacy code", glyph: "rule",          h: 25,  blurb: "Unused code, dead deps & legacy debt to remove." },
};

export function stageKind(key: string): StageKindMeta {
  return STAGE_KINDS[key] ?? { title: key, glyph: "category", h: 250, blurb: "" };
}
export const STAGE_KIND_KEYS = Object.keys(STAGE_KINDS);

// ── output dispositions: what happens to a stage's artifact ───────────────────
export interface DispositionMeta { title: string; glyph: string; h: number; desc: string }

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
  if (key === "permissions" || key === "context") return "knowledge";
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
