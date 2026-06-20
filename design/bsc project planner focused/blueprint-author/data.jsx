/* =====================================================================
   data.jsx — the Blueprint Author flow.
   The "Blueprint Author" is a meta-blueprint: planning WITH it means
   authoring a NEW blueprint through four focused stages —
   Purpose · Stages · Capabilities · Review & Publish.
   Catalog data (stage kinds, dispositions, pipelines) is ported from the
   repo's blueprintCatalog.ts; the in-progress blueprint is sample content.
   ===================================================================== */

// ── hue helpers (oklch accents) ──
const hue  = (h) => `oklch(0.74 0.11 ${h})`;
const tint = (h, a) => `oklch(0.74 0.11 ${h} / ${a})`;

// ── stage kinds: the palette a blueprint can contain ──
const STAGE_KINDS = {
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
};
const stageKind = (key) => STAGE_KINDS[key] || { title: key, glyph: "category", h: 250, blurb: "" };
const STAGE_KIND_KEYS = Object.keys(STAGE_KINDS);

// ── output dispositions: what happens to a stage's artifact ──
const DISPOSITIONS = {
  "plan-file":   { title: "Plan file",       glyph: "description", h: 70,  desc: "Written to the plan directory." },
  issues:        { title: "GitHub issues",   glyph: "task_alt",    h: 230, desc: "Published as tracked issues." },
  milestones:    { title: "Milestones",      glyph: "flag",        h: 295, desc: "Synced to repo milestones." },
  "skill-index": { title: "Skill index",     glyph: "extension",   h: 70,  desc: "Upserted into Skills library." },
  knowledge:     { title: "Knowledge store", glyph: "psychology",  h: 195, desc: "Injected into agent prompts." },
  scratch:       { title: "Scratch",         glyph: "edit_note",   h: 250, desc: "Working note — not published." },
};
const DISPOSITION_KEYS = Object.keys(DISPOSITIONS);
const defaultDisposition = (key) => {
  if (key === "structure") return "issues";
  if (key === "skills") return "skill-index";
  if (key === "permissions" || key === "context") return "knowledge";
  return "plan-file";
};

// ── pipeline library (reconstructed from PIPELINE_META + suits) ──
const PIPELINE_LIB = [
  { id: "render-preview",  name: "Render preview",  glyph: "preview",       h: 350, gateable: true,  desc: "Interactive screen walkthrough in a sandbox.",      suits: ["ui"] },
  { id: "file-intake",     name: "File intake",     glyph: "cloud_download", h: 350, gateable: false, desc: "Pull in attached specs, docs & assets.",            suits: ["context", "ui"] },
  { id: "lint-plan",       name: "Lint plan",       glyph: "rule",          h: 25,  gateable: true,  desc: "Validate plan completeness before advancing.",     suits: ["context", "structure", "testing"] },
  { id: "generate-issues", name: "Generate issues", glyph: "checklist",     h: 70,  gateable: false, desc: "Decompose the plan into tracked GitHub issues.",    suits: ["structure"] },
  { id: "grade-rubric",    name: "Grade · rubric",  glyph: "rule",          h: 145, gateable: true,  desc: "Score the artifact against a fixed rubric.",        suits: ["structure", "testing"] },
  { id: "grade-llm",       name: "Grade · LLM",     glyph: "fact_check",    h: 295, gateable: false, desc: "Model-graded review of the stage output.",          suits: ["structure", "testing"] },
  { id: "sync-milestones", name: "Sync milestones", glyph: "sync",          h: 70,  gateable: false, desc: "Reconcile milestones with the repo board.",         suits: ["structure"] },
  { id: "scope-streams",   name: "Scope streams",   glyph: "lan",           h: 230, gateable: false, desc: "Assign least-privilege posture per work stream.",   suits: ["permissions", "structure"] },
  { id: "sync-skills",     name: "Sync skills",     glyph: "extension",     h: 70,  gateable: false, desc: "Upsert authored skills into the library.",          suits: ["skills"] },
  { id: "schema-check",    name: "Schema check",    glyph: "database",      h: 145, gateable: true,  desc: "Validate entities, relations & migrations.",        suits: ["schema"] },
  { id: "contract-test",   name: "Contract test",   glyph: "fact_check",    h: 195, gateable: true,  desc: "Verify endpoints honor their interface contracts.", suits: ["api"] },
  { id: "index-repos",     name: "Index repos",     glyph: "account_tree",  h: 230, gateable: false, desc: "Clone & index linked repositories.",                suits: ["repos"] },
  { id: "arm-schedule",    name: "Arm schedule",    glyph: "bolt",          h: 145, gateable: false, desc: "Activate cron jobs & knowledge injections.",        suits: ["automations"] },
  { id: "export-notion",   name: "Export to Notion", glyph: "menu_book",    h: 70,  gateable: false, desc: "Mirror docs to a Notion workspace.",                suits: ["docs"] },
];
const pipelineMeta = (id) => PIPELINE_LIB.find((p) => p.id === id) || { glyph: "conveyor_belt", h: 250, gateable: false, name: id };
const TRIGGERS = [
  { value: "enter",    label: "enter",    full: "on section enter" },
  { value: "change",   label: "change",   full: "on artifact change" },
  { value: "complete", label: "complete", full: "on completion" },
  { value: "manual",   label: "manual",   full: "manual" },
];

// ── skills library (pickable per stage) ──
const SKILL_LIB = [
  { id: "sk_ws",      name: "realtime-ws-patterns", kind: "skill",     desc: "Connection lifecycle, heartbeats, reconnect & backpressure." },
  { id: "sk_idemp",   name: "idempotent-handlers",  kind: "skill",     desc: "Dedupe keys + at-least-once delivery for event handlers." },
  { id: "sk_otel",    name: "otel-conventions",     kind: "skill",     desc: "Span naming, trace propagation & metric cardinality rules." },
  { id: "sk_house",   name: "house-style",          kind: "knowledge", desc: "Repo coding conventions & review checklist." },
  { id: "sk_pg",      name: "postgres-migrations",  kind: "knowledge", desc: "Zero-downtime migration patterns for Postgres." },
];

// ── the blueprint being authored ──
let uidN = 0;
const uid = () => `s${++uidN}`;
const mkStage = (key, name, prompt, deps, pipelines, output, skills) => ({
  uid: uid(), key, name: name || stageKind(key).title,
  prompt: prompt || "", deps: deps || [],
  pipelines: (pipelines || []).map((p) => ({ uid: uid(), ...p })),
  output: output || defaultDisposition(key), skills: skills || [],
});

const BLUEPRINT = {
  name: "Realtime API service",
  icon: "R", h: 195,
  pitch: "Plan a production realtime backend — websockets, contracts & observability baked in.",
  desc: "An opinionated flow for event-driven API services: lock the contract first, model the data, then wire delivery and tracing. Every stage that can drift is gated.",
  audience: "Backend & platform teams",
  bestFor: ["backend", "realtime", "api"],
  visibility: "private-gist",
  author: "you",
  stages: [
    mkStage("context", "Context", "Capture the service's purpose, SLAs, and non-negotiables. Pin the protocol spec and any prior decisions the fleet should plan against.",
      [], [["file-intake", { id: "file-intake", name: "File intake", trigger: "manual", gate: false, enabled: true }]], "knowledge", ["sk_house"]),
    mkStage("users", "Users & personas", "Identify the clients consuming this API — first-party apps, partners, internal services — and the jobs each needs done.",
      ["context"], [], "plan-file", []),
    mkStage("stack", "Tech stack", "Choose languages, the websocket runtime, the datastore, and deployment target. Justify each against the SLAs from Context.",
      ["context"], [], "plan-file", []),
    mkStage("schema", "Data model", "Define entities, relations, and the migration plan. Schema-check gates completion so a malformed model can't advance.",
      ["stack"], [{ id: "schema-check", name: "Schema check", trigger: "change", gate: true, enabled: true }], "plan-file", ["sk_pg"]),
    mkStage("api", "API & contracts", "Specify every endpoint and event frame as an interface contract. Contract-test gates the stage — no drift past this point.",
      ["schema"], [{ id: "contract-test", name: "Contract test", trigger: "complete", gate: true, enabled: true }], "plan-file", ["sk_ws", "sk_idemp"]),
    mkStage("structure", "Structure", "Decompose the plan into milestones, epics, and issues with acceptance criteria, then publish to the board.",
      ["api"], [
        { id: "lint-plan", name: "Lint plan", trigger: "change", gate: true, enabled: true },
        { id: "generate-issues", name: "Generate issues", trigger: "complete", gate: false, enabled: true },
      ], "issues", []),
    mkStage("observability", "Observability", "Plan structured logs, metrics, and tracing across the delivery path before any code ships.",
      ["api"], [], "plan-file", ["sk_otel"]),
  ],
};

// ── the four authoring phases ──
// status derives from the active index at runtime.
const PHASES = [
  { key: "purpose", title: "Purpose", n: 1, view: "purpose", glyph: "flag", h: 70,
    blurb: "Define what this blueprint is for, who it serves, and how it'll appear in the catalog.",
    gate: { name: "identity-check", note: "name, pitch & at least one tag" } },
  { key: "stages", title: "Stages", n: 2, view: "stages", glyph: "account_tree", h: 230,
    blurb: "Compose the stage flow — order, dependencies, and the prompt module each stage runs.",
    gate: { name: "flow-check", note: "≥ 2 stages, every prompt written, deps acyclic" } },
  { key: "capabilities", title: "Capabilities", n: 3, view: "capabilities", glyph: "bolt", h: 145,
    blurb: "Wire each stage's pipelines, gates, output disposition, and attached skills.",
    gate: { name: "gate-check", note: "at least one gate guards the flow" } },
  { key: "publish", title: "Review & Publish", n: 4, view: "publish", glyph: "upload", h: 295,
    blurb: "Validate the blueprint, choose its visibility, and publish it to the catalog.",
    gate: { name: "lint", note: "all validation checks pass" } },
];

Object.assign(window, {
  hue, tint, STAGE_KINDS, stageKind, STAGE_KIND_KEYS,
  DISPOSITIONS, DISPOSITION_KEYS, defaultDisposition,
  PIPELINE_LIB, pipelineMeta, TRIGGERS, SKILL_LIB,
  BLUEPRINT, PHASES, mkStage,
});
