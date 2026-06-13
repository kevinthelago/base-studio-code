/* ===== Blueprints · seed data + registries ===== */
/* All exported on window for cross-file (Babel) access. */

// Hue-keyed accent helper — accents share L/C, vary hue (per design tokens).
function hue(h) { return `oklch(0.74 0.11 ${h})`; }
function tint(h, a) { return `oklch(0.74 0.11 ${h} / ${a})`; }

// ---- Stage kinds: the palette of planning stages a blueprint can contain ----
// glyph = Material Symbols ligature name (rendered via the icon font); h = hue.
const STAGE_KINDS = {
  context:      { title: "Context",        glyph: "flag",            h: 70,  blurb: "Pitch, goals & house rules the agents read first." },
  repos:        { title: "Repositories",   glyph: "account_tree",    h: 230, blurb: "Which repos this project spans + linking." },
  users:        { title: "Users & personas", glyph: "group",         h: 295, blurb: "Who it's for and the jobs they need done." },
  ux:           { title: "UI design",      glyph: "design_services", h: 350, blurb: "Screen skeletons & flows — feeds render-preview." },
  stack:        { title: "Tech stack",     glyph: "layers",          h: 195, blurb: "Languages, frameworks & runtime choices." },
  architecture: { title: "Architecture",   glyph: "hub",             h: 230, blurb: "Services, boundaries & how pieces fit." },
  schema:       { title: "Data model",     glyph: "database",        h: 145, blurb: "Entities, relations & migrations." },
  api:          { title: "API & contracts", glyph: "api",            h: 195, blurb: "Endpoints & interface contracts." },
  structure:    { title: "Structure",      glyph: "checklist",       h: 70,  blurb: "Milestones, issues & stream labels." },
  permissions:  { title: "Permissions",    glyph: "key",             h: 25,  blurb: "Per-capability posture for each agent." },
  automations:  { title: "Automations",    glyph: "bolt",            h: 145, blurb: "Cron jobs & knowledge injections." },
  skills:       { title: "Skills",         glyph: "extension",       h: 70,  blurb: "Reusable capability bundles to index." },
  testing:      { title: "Testing",        glyph: "science",         h: 145, blurb: "Test strategy & coverage gates." },
  security:     { title: "Security",       glyph: "security",        h: 25,  blurb: "Threat model, secrets & access review." },
  observability:{ title: "Observability",  glyph: "monitoring",      h: 230, blurb: "Logging, metrics & tracing plan." },
  infra:        { title: "Infrastructure", glyph: "dns",             h: 295, blurb: "Hosting, environments & provisioning." },
  cicd:         { title: "CI/CD",          glyph: "deployed_code",   h: 195, blurb: "Build, test & release pipelines." },
  docs:         { title: "Documentation",  glyph: "menu_book",       h: 70,  blurb: "READMEs, guides & reference docs." },
};

// ---- Pipelines: pluggable actions that run on a stage's output ----
const PIPELINES = {
  "render-preview": { name: "render-preview", glyph: "preview", h: 350, gateable: true,  defaultTrigger: "complete",
    desc: "Bundles UI skeletons with esbuild-wasm → live 2D/3D walkthrough in a sandboxed iframe.", kinds: ["ux"] },
  "lint-plan":      { name: "lint-plan", glyph: "rule", h: 25, gateable: true, defaultTrigger: "change",
    desc: "Scans artifacts for gaps (empty files, unresolved placeholders) and blocks on failure." },
  "issue-gen":      { name: "issue-gen", glyph: "checklist", h: 70, gateable: false, defaultTrigger: "complete",
    desc: "Generates granular GitHub issues from the stage artifact." , kinds: ["structure"] },
  "milestone-sync": { name: "milestone-sync", glyph: "sync", h: 70, gateable: false, defaultTrigger: "complete",
    desc: "Creates / updates milestones to mirror the roadmap." , kinds: ["structure"] },
  "stream-scope":   { name: "stream-scope", glyph: "lan", h: 230, gateable: false, defaultTrigger: "complete",
    desc: "Derives least-privilege stream labels + worktree boundaries." },
  "skill-index":    { name: "skill-index", glyph: "extension", h: 70, gateable: false, defaultTrigger: "complete",
    desc: "Indexes referenced skills into the global Skills library.", kinds: ["skills"] },
  "schema-check":   { name: "schema-check", glyph: "database", h: 145, gateable: true, defaultTrigger: "change",
    desc: "Validates the data model for orphan relations & missing migrations.", kinds: ["schema"] },
  "contract-test":  { name: "contract-test", glyph: "fact_check", h: 195, gateable: true, defaultTrigger: "complete",
    desc: "Runs contract tests against the declared API surface.", kinds: ["api"] },
};

// ---- Output dispositions: what happens to a stage's artifact ----
const DISPOSITIONS = {
  "plan-file":  { title: "Plan file",      glyph: "description", h: 70,  desc: "Written to the plan directory." },
  "issues":     { title: "GitHub issues",  glyph: "task_alt",    h: 230, desc: "Published as tracked issues." },
  "milestones": { title: "Milestones",     glyph: "flag",        h: 295, desc: "Synced to repo milestones." },
  "skill-index":{ title: "Skill index",    glyph: "extension",   h: 70,  desc: "Upserted into Skills library." },
  "knowledge":  { title: "Knowledge store", glyph: "psychology", h: 195, desc: "Injected into agent prompts." },
  "scratch":    { title: "Scratch",        glyph: "edit_note",   h: 250, desc: "Working note — not published." },
};

// trigger options shown in the segmented control
const TRIGGERS = ["enter", "change", "complete", "manual"];

let _uid = 1000;
function uid(p) { return `${p}_${++_uid}`; }

// build a stage from a kind key
function mkStage(kind, over = {}) {
  const k = STAGE_KINDS[kind];
  return {
    id: uid("st"),
    kind,
    title: k ? k.title : kind,
    prompt: over.prompt || defaultPrompt(kind),
    dependsOn: over.dependsOn || [],
    pipelines: over.pipelines || [],
    output: over.output || defaultOutput(kind),
    ...over,
  };
}
function defaultOutput(kind) {
  if (kind === "structure") return "issues";
  if (kind === "skills") return "skill-index";
  if (kind === "permissions") return "knowledge";
  if (kind === "context") return "knowledge";
  return "plan-file";
}
function defaultPrompt(kind) {
  const k = STAGE_KINDS[kind];
  return `Document the project's ${k ? k.title.toLowerCase() : kind}. ${k ? k.blurb : ""}`;
}
function mkPipe(key, over = {}) {
  const p = PIPELINES[key];
  return { id: uid("pp"), key, trigger: over.trigger || (p ? p.defaultTrigger : "complete"),
    gate: over.gate ?? (p ? p.gateable : false), enabled: over.enabled ?? true };
}

// ---- The four built-in blueprints (README) ----
function buildBlueprints() {
  const bps = [];

  // 1 · Default
  bps.push({
    id: "bp_default", name: "Default", icon: "D", h: 70, origin: "built-in",
    desc: "The general-purpose planning arc. A balanced set of stages for most projects.",
    tags: ["built-in", "general"],
    gist: { state: "local" },
    uses: 218, updatedAt: "2026-05-30",
    stages: [
      mkStage("context"),
      mkStage("repos", { dependsOn: [] }),
      mkStage("ux", { pipelines: [mkPipe("render-preview", { gate: true })] }),
      mkStage("structure", { pipelines: [mkPipe("issue-gen"), mkPipe("milestone-sync")] }),
      mkStage("permissions"),
      mkStage("automations"),
      mkStage("skills", { pipelines: [mkPipe("skill-index")] }),
    ],
  });

  // 2 · Full-stack web app
  bps.push({
    id: "bp_fullstack", name: "Full-stack web app", icon: "W", h: 230, origin: "built-in",
    desc: "Frontend + API + database, wired for a render-preview gate and contract tests.",
    tags: ["built-in", "web"],
    gist: { state: "synced", id: "a91f3c0e7", url: "gist.github.com/studio/a91f3c0e7",
      public: true, author: "studio", rev: "r7", lastSync: "2026-06-02" },
    uses: 96, updatedAt: "2026-06-02",
    stages: [
      mkStage("context"),
      mkStage("users"),
      mkStage("stack"),
      mkStage("architecture", { dependsOn: [] }),
      mkStage("schema", { pipelines: [mkPipe("schema-check", { gate: true })] }),
      mkStage("api", { pipelines: [mkPipe("contract-test", { gate: true })] }),
      mkStage("ux", { pipelines: [mkPipe("render-preview", { gate: true })] }),
      mkStage("structure", { pipelines: [mkPipe("issue-gen"), mkPipe("stream-scope")] }),
      mkStage("permissions"),
      mkStage("cicd"),
    ],
  });

  // 3 · Mobile MVP
  bps.push({
    id: "bp_mobile", name: "Mobile MVP", icon: "M", h: 295, origin: "built-in",
    desc: "Lean stage set for shipping a focused mobile MVP fast — design-forward, light process.",
    tags: ["built-in", "mobile", "lean"],
    gist: { state: "local" },
    uses: 54, updatedAt: "2026-05-21",
    stages: [
      mkStage("context"),
      mkStage("users"),
      mkStage("ux", { pipelines: [mkPipe("render-preview", { gate: true })] }),
      mkStage("stack"),
      mkStage("structure", { pipelines: [mkPipe("issue-gen")] }),
      mkStage("permissions"),
    ],
  });

  // 4 · API microservice
  bps.push({
    id: "bp_api", name: "API microservice", icon: "A", h: 195, origin: "built-in",
    desc: "Contract-first service blueprint — schema, API surface, and tests gate the build.",
    tags: ["built-in", "backend", "contract-first"],
    gist: { state: "local" },
    uses: 71, updatedAt: "2026-05-28",
    stages: [
      mkStage("context"),
      mkStage("stack"),
      mkStage("schema", { pipelines: [mkPipe("schema-check", { gate: true })] }),
      mkStage("api", { pipelines: [mkPipe("contract-test", { gate: true })] }),
      mkStage("testing", { pipelines: [mkPipe("lint-plan", { gate: true })] }),
      mkStage("observability"),
      mkStage("structure", { pipelines: [mkPipe("issue-gen"), mkPipe("stream-scope")] }),
      mkStage("cicd"),
    ],
  });

  return bps;
}

// ---- Community catalog: shared gist-blueprints (Browse / Fork) ----
const CATALOG = [
  { id: "cat_rust", name: "Rust CLI tool", icon: "R", h: 25, author: "ferris-dev", stars: 342,
    desc: "Cargo-first stages with clippy + cross-compile gates. Great for terminal tooling.",
    stageCount: 7, gistId: "f0c1a9", updated: "3d ago", tags: ["cli", "rust"] },
  { id: "cat_ml", name: "ML training pipeline", icon: "M", h: 295, author: "tensor-kate", stars: 511,
    desc: "Data lifecycle → experiment tracking → eval gate → model card. Built for reproducibility.",
    stageCount: 9, gistId: "9b3e22", updated: "1w ago", tags: ["ml", "data"] },
  { id: "cat_chrome", name: "Chrome extension", icon: "C", h: 70, author: "mv3-mike", stars: 188,
    desc: "Manifest V3 scaffold with permissions audit + store-listing stage.",
    stageCount: 6, gistId: "c7d0f1", updated: "2d ago", tags: ["extension", "web"] },
  { id: "cat_saas", name: "B2B SaaS starter", icon: "S", h: 230, author: "acme-platform", stars: 904,
    desc: "Multi-tenant arch, billing, RBAC, and an onboarding-flow render-preview gate.",
    stageCount: 12, gistId: "1a2b3c", updated: "5h ago", tags: ["saas", "web", "auth"] },
  { id: "cat_game", name: "Indie game jam", icon: "G", h: 350, author: "pixel-pat", stars: 263,
    desc: "48-hour scope discipline — vibe, mechanics, one vertical slice. No process bloat.",
    stageCount: 5, gistId: "e5f6a7", updated: "6d ago", tags: ["game", "lean"] },
  { id: "cat_data", name: "Data warehouse", icon: "D", h: 145, author: "dbt-dana", stars: 421,
    desc: "Source contracts → staging → marts with lineage docs and a schema-check gate.",
    stageCount: 8, gistId: "b8c9d0", updated: "4d ago", tags: ["data", "backend"] },
];

Object.assign(window, {
  STAGE_KINDS, PIPELINES, DISPOSITIONS, TRIGGERS, CATALOG,
  buildBlueprints, mkStage, mkPipe, uid, hue, tint, defaultPrompt,
});
