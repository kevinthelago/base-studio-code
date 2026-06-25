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
  ui:            { title: "UI design",        glyph: "design_services", h: 350, blurb: "Claude Design kickoff + route the user's design files." },
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
  // Greenfield workshop + lifecycle stages (#…): these have SECTION_DEFS (one project pane each)
  // but were absent from this map, so their card/editor icon fell through to the generic
  // `category` square. Each is mapped to a Lucide glyph already in the ICONS set.
  features:      { title: "Features",         glyph: "task_alt",        h: 160, blurb: "The user-facing capabilities — each one a stream." },
  deploy:        { title: "Deploy",           glyph: "conveyor_belt",   h: 30,  blurb: "How each service ships — target, environments, pipeline, secrets." },
  boundaries:    { title: "Service boundaries", glyph: "hub",           h: 260, blurb: "Bounded contexts and the seams to split the monolith along." },
  extraction:    { title: "Extraction plan",  glyph: "fork_right",      h: 90,  blurb: "Incremental, shippable steps to carve each service out." },
  consolidation: { title: "Consolidation plan", glyph: "account_tree",  h: 110, blurb: "Merge services back together, unifying data & contracts." },
  migration:     { title: "Migration plan",   glyph: "sync",            h: 50,  blurb: "The from→to mapping and an incremental, reversible cutover." },
  hardening:     { title: "Security hardening", glyph: "security",      h: 15,  blurb: "Threat model, an authz/secrets/deps audit, and concrete fixes." },
  integrations:  { title: "Integrations",     glyph: "link",            h: 280, blurb: "The tools, connectors, and credentials the plan implies." },
  mcp:           { title: "MCP servers",      glyph: "lan",             h: 200, blurb: "External tools + data the fleet's agents can call." },
  // Data-platform / migration stages (#779–786) — one project pane each (ProjectPane focused body).
  source:        { title: "Source",           glyph: "cloud_download",  h: 250, blurb: "Connect the legacy systems you're migrating from, read-only." },
  dataSource:    { title: "Source",           glyph: "database",        h: 245, blurb: "Connect the system of record and inventory what's there." },
  collectTargets:{ title: "Targets",          glyph: "account_tree",    h: 300, blurb: "Declare the external sources and the Data Model they feed." },
  sourceLicensing:{ title: "Source legitimacy", glyph: "fact_check",    h: 15,  blurb: "ToS / robots / license clearance — blocks acquisition." },
  dataModel:     { title: "Data Model",       glyph: "database",        h: 150, blurb: "The canonical schema everything maps into." },
  dataAcquire:   { title: "Acquire",          glyph: "cloud_download",  h: 255, blurb: "Scrape (rate-limited, robots-aware) or fetch the raw data." },
  dataExtract:   { title: "Extract",          glyph: "description",     h: 200, blurb: "Parse raw artifacts into structured rows." },
  dataMap:       { title: "Mapping",          glyph: "account_tree",    h: 230, blurb: "Field-by-field: source object → Data Model entity." },
  dataClean:     { title: "Cleaning",         glyph: "rule",            h: 20,  blurb: "Coerce, standardize, validate against the Data Model." },
  dataLoad:      { title: "Load & reconcile", glyph: "upload",          h: 330, blurb: "Merge into the Data Model by identity key, with lineage." },
  destination:   { title: "Destination",      glyph: "upload",          h: 320, blurb: "Where the extracted data is delivered — sink + write semantics." },
  sync:          { title: "Sync & schedule",  glyph: "sync",            h: 60,  blurb: "How and how often the data syncs — full vs. incremental." },
  // Blueprint-authoring stages (#923) — the meta-blueprint editor's own panes.
  purpose:       { title: "Purpose",          glyph: "flag",            h: 65,  blurb: "What this blueprint is for, who it serves, how it appears." },
  bp_stages:     { title: "Stages",           glyph: "layers",          h: 200, blurb: "Compose the stage flow — order, dependencies, prompts." },
  bp_capabilities:{ title: "Capabilities",    glyph: "extension",       h: 75,  blurb: "Wire each stage's disposition, skills/knowledge, and MCP servers." },
  bp_review:     { title: "Review & publish", glyph: "fact_check",      h: 290, blurb: "Validate the blueprint, choose visibility, and publish." },
};

export function stageKind(key: string): StageKindMeta {
  return STAGE_KINDS[key] ?? { title: key, glyph: "category", h: 250, blurb: "" };
}

/** The kinds offered in the editor's "add stage" palette — a CURATED subset of {@link STAGE_KINDS},
 *  NOT every entry. The map now also carries icon/metadata for stages that arrive via blueprints or
 *  SECTION_DEFS but aren't hand-addable (the data-platform pipeline stages, the lifecycle stages
 *  seeded by their category's built-in, and the blueprint-authoring meta-stages), so an imported
 *  blueprint resolves a real icon for every stage without those flooding the palette. */
export const STAGE_KIND_KEYS = [
  "context", "repos", "users", "ui", "stack", "architecture", "schema", "api",
  "structure", "permissions", "automations", "skills", "testing", "security",
  "observability", "infra", "cicd", "docs", "cleanup",
];

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
