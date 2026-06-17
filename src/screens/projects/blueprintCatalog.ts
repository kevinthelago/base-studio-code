// Blueprints-page registry layer (#609) — the editor's palette metadata, ported from
// the design (design/base-studio-code-blueprints/js/data.jsx) and reconciled with our
// runtime model: stage keys match ours (`ui`, not the design's `ux`), and pipeline
// metadata is keyed by our canonical PIPELINE_LIB ids. Pure; the editor reads this for
// glyphs/hues/blurbs/dispositions; the runtime (#584 gateRule/sectionStatus) is unchanged.

import { type PipelineTrigger } from "./blueprints";

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

// ── pipeline editor metadata (keyed by our PIPELINE_LIB ids) ──────────────────
export interface PipelineMeta { glyph: string; h: number; gateable: boolean; defaultTrigger: PipelineTrigger }

// Trimmed to the implemented pipelines (#897 Phase 4a) — the 14 no-op catalog entries were
// removed from PIPELINE_LIB, so their editor metadata went with them.
export const PIPELINE_META: Record<string, PipelineMeta> = {
  "render-preview":  { glyph: "preview",       h: 350, gateable: true,  defaultTrigger: "on completion" },
  "grade-plan":      { glyph: "fact_check",    h: 70,  gateable: false, defaultTrigger: "on completion" },
  "lint-plan":       { glyph: "rule",          h: 25,  gateable: true,  defaultTrigger: "on artifact change" },
};

export function pipelineMeta(id: string): PipelineMeta {
  return PIPELINE_META[id] ?? { glyph: "conveyor_belt", h: 250, gateable: false, defaultTrigger: "on completion" };
}

// ── trigger labels: editor shows short labels, model stores the canonical forms ─
export const TRIGGER_LABELS: { value: PipelineTrigger; label: string }[] = [
  { value: "on section enter",   label: "enter" },
  { value: "on artifact change", label: "change" },
  { value: "on completion",      label: "complete" },
  { value: "manual",             label: "manual" },
];

// ── community catalog: shared gist-blueprints to Browse / Fork (#609 slice 5) ──
// A static starter list for now; discovery becomes federated "sources" later (#598).
export interface CatalogEntry {
  id: string;
  name: string;
  icon: string;
  h: number;
  author: string;
  stars: number;
  desc: string;
  stageCount: number;
  gistId: string;
  updated: string;
  tags: string[];
}

export const CATALOG: CatalogEntry[] = [
  { id: "cat_rust",   name: "Rust CLI tool",        icon: "R", h: 25,  author: "ferris-dev",     stars: 342, stageCount: 7,  gistId: "f0c1a9", updated: "3d ago", tags: ["cli", "rust"], desc: "Cargo-first stages with clippy + cross-compile gates. Great for terminal tooling." },
  { id: "cat_ml",     name: "ML training pipeline", icon: "M", h: 295, author: "tensor-kate",    stars: 511, stageCount: 9,  gistId: "9b3e22", updated: "1w ago", tags: ["ml", "data"], desc: "Data lifecycle → experiment tracking → eval gate → model card. Built for reproducibility." },
  { id: "cat_chrome", name: "Chrome extension",     icon: "C", h: 70,  author: "mv3-mike",       stars: 188, stageCount: 6,  gistId: "c7d0f1", updated: "2d ago", tags: ["extension", "web"], desc: "Manifest V3 scaffold with permissions audit + store-listing stage." },
  { id: "cat_saas",   name: "B2B SaaS starter",     icon: "S", h: 230, author: "acme-platform",  stars: 904, stageCount: 12, gistId: "1a2b3c", updated: "5h ago", tags: ["saas", "web", "auth"], desc: "Multi-tenant arch, billing, RBAC, and an onboarding-flow render-preview gate." },
  { id: "cat_game",   name: "Indie game jam",       icon: "G", h: 350, author: "pixel-pat",      stars: 263, stageCount: 5,  gistId: "e5f6a7", updated: "6d ago", tags: ["game", "lean"], desc: "48-hour scope discipline — vibe, mechanics, one vertical slice. No process bloat." },
  { id: "cat_data",   name: "Data warehouse",       icon: "D", h: 145, author: "dbt-dana",       stars: 421, stageCount: 8,  gistId: "b8c9d0", updated: "4d ago", tags: ["data", "backend"], desc: "Source contracts → staging → marts with lineage docs and a schema-check gate." },
];

/** Synthesize a plausible stage-key flow for a catalog entry of N stages (for preview/fork). */
export const CATALOG_FLOW_KINDS = [
  "context", "users", "stack", "architecture", "schema", "api", "ui", "structure", "permissions", "testing", "observability", "cicd",
];
