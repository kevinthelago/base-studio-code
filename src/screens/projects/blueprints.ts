// Blueprints (#513/#514): the model behind the Blueprints page. A blueprint is an
// ordered list of planning SECTIONS (stages) that seeds every new project. Each
// section owns its prompt module (the instructions Claude receives for that stage)
// and its PIPELINES — pluggable actions that run on the stage's output. Pure (no
// React/Tauri) so it's unit-testable and the store can seed from it directly.
//
// Mirrors design/base-studio-code-projects/Blueprints.html.

import { PLAN_STAGES, type StageConfig, type StageId } from "./planStages";
import {
  evalGate, gateApplies,
  type StageGate, type Requirement, type PlanSignals,
} from "./stageGate";

// ── ids ──────────────────────────────────────────────────────────────────────
let _id = 0;
/** Ephemeral handle for a section/pipeline instance (stable within a session). */
export const uid = (p: string) => `${p}-${++_id}`;

// ── Pipelines ────────────────────────────────────────────────────────────────
// kind: "builtin" (ships with the app) · "external" (third-party integration) ·
//       "custom" (user wires their own command/webhook).
export type PipelineKind = "builtin" | "external" | "custom";
export type PipelineTrigger = "on section enter" | "on artifact change" | "on completion" | "manual";
export const TRIGGERS: PipelineTrigger[] = ["on section enter", "on artifact change", "on completion", "manual"];

export interface PipelineDef {
  id: string;
  name: string;
  desc: string;
  /** Section keys this pipeline suits; "*" = any stage. */
  suits: string[];
  kind: PipelineKind;
}

export interface Pipeline extends PipelineDef {
  uid: string;
  trigger: PipelineTrigger;
  enabled: boolean;
  /** A gate pipeline blocks its stage from completing until it passes (#532). */
  gate?: boolean;
}

export const PIPELINE_LIB: PipelineDef[] = [
  { id: "render-preview",  name: "Render preview",      desc: "Visualize screens as a 2D / 3D walkthrough", suits: ["ui"],          kind: "builtin"  },
  { id: "file-intake",     name: "Drop files",          desc: "Drag in design or any files; the planner routes them to the right repo", suits: ["ui", "*"], kind: "builtin" },
  { id: "push-figma",      name: "Push to Figma",       desc: "Export generated frames to a Figma file",    suits: ["ui"],          kind: "external" },
  { id: "generate-issues", name: "Generate issues",     desc: "Turn phases into granular GitHub issues",    suits: ["structure"],   kind: "builtin"  },
  { id: "grade-plan",      name: "Grade plan",          desc: "Score agent-readiness and suggest fixes",    suits: ["structure"],   kind: "builtin"  },
  { id: "grade-rubric",    name: "Grade section",       desc: "Score this section against a rubric (report card)", suits: ["*"],     kind: "builtin"  },
  { id: "grade-llm",       name: "Claude review",       desc: "Ask Claude to grade this section against its rubric", suits: ["*"],   kind: "builtin"  },
  { id: "scan-dead-code",  name: "Scan dead code",      desc: "Find unused code & deps (depcheck / ts-prune / cargo-machete)", suits: ["*"], kind: "builtin" },
  { id: "sync-milestones", name: "Sync milestones",     desc: "Publish phases as GitHub milestones",        suits: ["structure"],   kind: "builtin"  },
  { id: "lint-plan",       name: "Lint plan",           desc: "Validate this stage's output for gaps",      suits: ["*"],           kind: "builtin"  },
  { id: "scope-streams",   name: "Scope streams",       desc: "Derive least-privilege agent profiles",      suits: ["permissions"], kind: "builtin"  },
  { id: "arm-schedule",    name: "Arm schedule",        desc: "Install a cron automation rule",             suits: ["automations"], kind: "builtin"  },
  { id: "sync-skills",     name: "Sync skill library",  desc: "Upsert reusable skills into the library",    suits: ["skills"],      kind: "builtin"  },
  { id: "index-repos",     name: "Clone & index repos", desc: "Clone linked repos and build a code index",  suits: ["repos"],       kind: "builtin"  },
  { id: "export-notion",   name: "Export to Notion",    desc: "Mirror this stage's doc into a Notion page", suits: ["*"],           kind: "external" },
  { id: "schema-check",    name: "Schema check",        desc: "Validate the data model for orphan relations & missing migrations", suits: ["schema"], kind: "builtin" },
  { id: "contract-test",   name: "Contract test",       desc: "Run contract tests against the declared API surface",               suits: ["api"],    kind: "builtin" },
];

// ── Sections (the canonical planning stages) ─────────────────────────────────
export interface SectionDef {
  name: string;
  glyph: string;
  /** Human-readable gate description, shown in the editor and the readiness feedback. */
  gate: string;
  deps: string[];
  blurb: string;
  prompt: string;
  /** Declarative completion gate (#…) — the DATA that decides this section's
   *  done-ness. Carried on every section instance so a section is fully serializable
   *  and distributable; the app evaluates it via {@link evalGate}. Absent ⇒ the
   *  section is informational (vacuously complete). */
  gateRule?: StageGate;
  /** Optional applicability rule (e.g. UI only when the project needs a UI). Absent ⇒
   *  the section always applies. */
  appliesWhen?: Requirement;
  /** Output disposition (#609) — what happens to this stage's artifact (a key into
   *  DISPOSITIONS: plan-file / issues / milestones / skill-index / knowledge / scratch).
   *  Editor metadata; the runtime doesn't read it. Absent ⇒ defaultDisposition(key). */
  output?: string;
  /** Attached skills/knowledge (#636) — library item ids (KB blocks or Skills) injected
   *  into the agent's context for this stage. Resolved at planning + fleet launch
   *  (slice b). Reference-by-id; unresolved ids surface a warning. */
  skills?: string[];
}

export const SECTION_DEFS: Record<string, SectionDef> = {
  context: {
    name: "Context", glyph: "◆", gate: "all topics resolved", deps: [],
    // core four confirmed (must-pass, no fill) + every surfaced topic resolved.
    gateRule: { require: [
      { signal: "coreConfirmed", target: true, weight: 0 },
      { signal: "topicsResolved", of: "topicsTotal", label: "resolve the discovery topics" },
    ] },
    blurb: "Discovery — goal, users, scope, UX, stack, architecture.",
    prompt:
`Walk the discovery checklist one topic at a time — goal, users, scope, UX,
stack, architecture, data model, API, security, testing. Propose first, then
interrogate; confirm each topic before moving on. Write one section file per
resolved topic and emit a <plan_update> so the panel reveals it live.

Gate: every applicable topic is resolved or explicitly skipped (with a reason).`,
  },
  repos: {
    name: "Repos", glyph: "⑂", gate: "≥1 repo linked", deps: [],
    gateRule: { require: [{ signal: "repoCount", target: 1, label: "link at least one repository" }] },
    blurb: "Link the repositories this project spans.",
    prompt:
`Link the repositories this project spans. For each, record owner/repo, default
branch, and its role in the system. Write repos.json.

Gate: at least one repository is linked.`,
  },
  ui: {
    name: "UI", glyph: "▣", gate: "screens & flows defined", deps: ["context"],
    // applies only when the project needs a UI; complete when every screen is approved.
    appliesWhen: { signal: "requiresUi", target: true },
    gateRule: { require: [{ signal: "screensApproved", of: "screensTotal", label: "approve the screen previews" }] },
    blurb: "Screens, states, and primary flows.",
    prompt:
`Define the screens and primary flows. For each screen: its purpose, key states,
and the components it needs from the design system. Produce ui.md plus a screen
inventory the Render preview pipeline can visualize.

Gate: every primary flow has its screens and states defined.`,
  },
  structure: {
    name: "Structure", glyph: "⊞", gate: "phases + issues", deps: ["context", "repos", "ui"],
    gateRule: { require: [
      { signal: "phasesConfirmed", target: true, label: "confirm the roadmap" },
      { signal: "issueCount", target: 1, label: "add agent-ready issues" },
    ] },
    blurb: "Phases (milestones) and agent-ready issues.",
    prompt:
`Map features into phases (milestones) and granular, agent-ready issues. Each
issue carries acceptance criteria, owned files/globs, dependencies, labels, and
its owning stream — enough that an agent finishes without asking. Write
phases.json and issues.json.

Gate: every phase has issues; every issue is agent-ready.`,
  },
  permissions: {
    name: "Permissions", glyph: "⛉", gate: "every stream scoped", deps: ["structure"],
    gateRule: { require: [
      { signal: "fleetStreams", target: 1, label: "plan the agent fleet" },
      { signal: "profilesComplete", target: true, label: "set a profile for every stream" },
    ] },
    blurb: "Least-privilege profile per work stream.",
    prompt:
`For every work stream, derive a least-privilege profile: allowed commands,
write-path globs, network access, and a git/gh push policy. Map each to a role
(worker / director / triage). Write the per-stream permission set.

Gate: every stream has a scoped profile and a role.`,
  },
  automations: {
    name: "Automations", glyph: "⚡", gate: "≥1 automation armed", deps: ["structure"],
    gateRule: { require: [{ signal: "automationsAck", target: true, label: "review automations for this project" }] },
    blurb: "Cron rules that load context or dispatch commands.",
    prompt:
`Propose cron-triggered rules that load a knowledge block or dispatch a command
into a console pane. Record each rule's trigger, target pane, and cadence. Write
automations.md.

Gate: at least one automation is armed.`,
  },
  skills: {
    name: "Skills", glyph: "✦", gate: "skills selected", deps: [],
    gateRule: { require: [{ signal: "skillsAck", target: true, label: "assign skills to the fleet" }] },
    blurb: "Reusable skills from the global library.",
    prompt:
`Select reusable skills from the global library that apply to this project's
stack, and propose any new ones worth saving for reuse. Write skills.json.

Gate: the applicable skills are selected.`,
  },
  testing: {
    name: "Testing", glyph: "✓", gate: "coverage strategy set", deps: ["structure"],
    blurb: "Test strategy, fixtures, and CI gates.",
    prompt:
`Define the testing strategy: unit / integration / e2e split, fixtures, and the
CI gates that must pass before merge to develop. Write testing.md.

Gate: a coverage strategy and CI gates are defined.`,
  },
  // Refactor & Cleanup blueprint (#626): find unused / dead / legacy code to remove.
  // Informational (no gateRule) — the scan-dead-code pipeline + cleanup grade drive it.
  cleanup: {
    name: "Dead & legacy code", glyph: "♻", gate: "findings triaged", deps: ["repos"],
    blurb: "Unused code, dead dependencies & legacy debt to remove.",
    prompt:
`Find what to remove or modernize: unused exports/files, unused dependencies, dead
feature flags, deprecated APIs, and duplicated code. Run the scan, verify each
candidate (static tools have false positives — dynamic refs, public API, test-only
use), then list confirmed removals as refactor units with a test safety net.`,
  },
  // ── transform / harden stages (#645 slice 2): informational (no signal gate) ──
  boundaries: {
    name: "Service boundaries", glyph: "⧉", gate: "boundaries mapped", deps: ["repos"],
    blurb: "Bounded contexts and the seams to split the monolith along.",
    prompt:
`Map the codebase into bounded contexts: cohesive modules, the data each owns, and the
call/coupling seams between them. Identify the cut lines for extraction and the shared
code that must be split or duplicated. Flag chatty couplings that would become costly
network calls once separated.`,
  },
  extraction: {
    name: "Extraction plan", glyph: "⤳", gate: "extraction sequenced", deps: ["boundaries"],
    blurb: "Incremental, shippable steps to carve each service out.",
    prompt:
`Sequence the split. For each service: its API/contract, the data it owns + how to
migrate it, and the strangler steps to extract it without a big-bang cutover. Order by
dependency and risk; keep the system shippable and reversible at every step.`,
  },
  consolidation: {
    name: "Consolidation plan", glyph: "⧈", gate: "merge mapped", deps: ["repos"],
    blurb: "Merge services back together, unifying data & contracts.",
    prompt:
`Map the services to merge: overlapping responsibilities, the data stores to unify, and
the inter-service calls that become in-process. Plan the merge order, the shared schema,
and how to retire the redundant deployments/contracts without downtime.`,
  },
  migration: {
    name: "Migration plan", glyph: "⇄", gate: "from→to mapped", deps: ["repos"],
    blurb: "The from→to mapping and an incremental, reversible cutover.",
    prompt:
`Define the migration: the from→to (framework / language / protocol / datastore), an
equivalence mapping, and an incremental cutover — run old + new in parallel, migrate
slice by slice, verify, then retire the old. Call out breaking changes and the
compatibility shims that bridge them.`,
  },
  hardening: {
    name: "Security hardening", glyph: "⛨", gate: "threats triaged", deps: ["repos"],
    blurb: "Threat model, an authz/secrets/deps audit, and concrete fixes.",
    prompt:
`Threat-model the system (assets, entry points, trust boundaries), then audit: authn/authz
gaps, secret handling, input validation, dependency CVEs, and transport/storage crypto.
Rank findings by severity and produce concrete, testable fixes — not just observations.`,
  },
};

export interface BlueprintSection extends SectionDef {
  uid: string;
  key: string;
  enabled: boolean;
  expanded: boolean;
  pipelines: Pipeline[];
}

/** Where a blueprint came from (#609) — drives the card's origin tag. */
export type BlueprintOrigin = "built-in" | "local" | "forked" | "imported";

/** Lifecycle intent of a blueprint (#645) — what part of a project's life it serves.
 *  Greenfield = create from a pitch; transform = restructure existing repos; harden =
 *  improve quality in place; maintain = ongoing upkeep. Drives library grouping/labels. */
export type BlueprintCategory = "greenfield" | "transform" | "harden" | "maintain";
export const BLUEPRINT_CATEGORIES: BlueprintCategory[] = ["greenfield", "transform", "harden", "maintain"];

/** Whether a blueprint starts from a pitch (create) or runs against existing repos
 *  (operate) — selects the planner intro at launch. */
export type BlueprintMode = "create" | "operate";

/** Display metadata per category (label + accent hue for the badge/filter). */
export const CATEGORY_META: Record<BlueprintCategory, { label: string; h: number }> = {
  greenfield: { label: "Greenfield", h: 145 },
  transform:  { label: "Transform",  h: 230 },
  harden:     { label: "Harden",     h: 25 },
  maintain:   { label: "Maintain",   h: 70 },
};

/** Gist link state for a blueprint (#609) — the publish/sync state-machine. Slice 5
 *  populates this; the Library card reads it for the sync badge. Absent ⇒ local-only. */
export interface BlueprintGist {
  state: "local" | "dirty" | "synced" | "forked";
  /** Whether an upstream update is available (forked blueprints). */
  behind?: boolean;
  rev?: string;
  author?: string;
  id?: string;
  url?: string;
  public?: boolean;
}

export interface Blueprint {
  id: string;
  name: string;
  desc: string;
  sections: BlueprintSection[];
  /** Display + provenance metadata (#609). All optional — the Library derives sensible
   *  fallbacks (icon from the name, hue from the id, origin "local", local-only gist). */
  icon?: string;
  /** Accent hue (oklch) for the card/editor icon. */
  h?: number;
  origin?: BlueprintOrigin;
  tags?: string[];
  gist?: BlueprintGist;
  /** How many projects this blueprint has seeded. */
  uses?: number;
  updatedAt?: string;
  /** Blueprint-wide attached skills/knowledge (#636) — applied across every stage,
   *  in addition to each section's own `skills`. Library item ids. */
  skills?: string[];
  /** Lifecycle intent (#645). Absent ⇒ greenfield (the create-a-project default). */
  category?: BlueprintCategory;
  /** Create (from a pitch) vs operate (against existing repos). Absent ⇒ create. */
  mode?: BlueprintMode;
}

/** A blueprint's category, defaulting to greenfield. */
export function blueprintCategory(bp: Blueprint): BlueprintCategory {
  return bp.category ?? "greenfield";
}

/** Filter blueprints by a free-text query (name/desc/tags) + optional category. Pure;
 *  drives the Library's search + category filter (#645). */
export function filterBlueprints(blueprints: Blueprint[], opts: { query?: string; category?: BlueprintCategory | "all" }): Blueprint[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const cat = opts.category ?? "all";
  return blueprints.filter((b) => {
    if (cat !== "all" && blueprintCategory(b) !== cat) return false;
    if (!q) return true;
    const hay = `${b.name} ${b.desc} ${(b.tags ?? []).join(" ")} ${blueprintCategory(b)}`.toLowerCase();
    return hay.includes(q);
  });
}

export const DEFAULT_BLUEPRINT_ID = "default";

/** Build a section instance from a def key + per-blueprint overrides. */
export function mkSection(
  key: string,
  { enabled = true, expanded = false, pipelines = [] as [string, PipelineTrigger?, boolean?][] } = {},
): BlueprintSection {
  const def = SECTION_DEFS[key];
  return {
    uid: uid("sec"), key, ...def, enabled, expanded,
    pipelines: pipelines.map(([libId, trigger, on]) => {
      const lib = PIPELINE_LIB.find((p) => p.id === libId)!;
      return { uid: uid("pl"), ...lib, trigger: trigger ?? "on completion", enabled: on !== false };
    }),
  };
}

/** Seed blueprints — the starter library, depicting every section/pipeline state. */
export function makeBlueprints(): Blueprint[] {
  return [
    {
      id: "default", name: "Default", desc: "Balanced starting point", origin: "built-in", category: "greenfield", mode: "create",
      sections: [
        mkSection("context",     { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("repos",       { enabled: false, pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("ui",          { pipelines: [["render-preview", "on artifact change", true], ["file-intake", "manual", true], ["push-figma", "on completion", true]] }),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false], ["sync-milestones", "on completion", false]] }),
        mkSection("permissions", { pipelines: [] }),
        mkSection("automations", { pipelines: [["arm-schedule", "on completion", true]] }),
        mkSection("skills",      { pipelines: [["sync-skills", "manual", true]] }),
      ],
    },
    {
      id: "fullstack", name: "Full-stack web app", desc: "Web client + API + DB", origin: "built-in", category: "greenfield", mode: "create",
      sections: [
        mkSection("context"), mkSection("repos"), mkSection("ui", { pipelines: [["render-preview", "on artifact change", true]] }),
        mkSection("structure", { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false]] }),
        mkSection("testing"), mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
        mkSection("automations"), mkSection("skills"),
      ],
    },
    {
      id: "mobile", name: "Mobile MVP", desc: "Single app, ship fast", origin: "built-in", category: "greenfield", mode: "create",
      sections: [
        mkSection("context"), mkSection("ui", { pipelines: [["render-preview", "on artifact change", true]] }),
        mkSection("structure", { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false]] }),
        mkSection("permissions"), mkSection("skills"),
      ],
    },
    {
      id: "api", name: "API microservice", desc: "Headless service, no UI", origin: "built-in", category: "greenfield", mode: "create",
      sections: [
        mkSection("context"), mkSection("repos"),
        mkSection("structure", { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false], ["sync-milestones", "on completion", true]] }),
        mkSection("testing"), mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
        mkSection("automations"),
      ],
    },
    {
      id: "refactor", name: "Refactor & Cleanup", desc: "Clean up an existing codebase — find dead/legacy code & refactor",
      origin: "built-in", icon: "♻", h: 25, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",       { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("cleanup",     { pipelines: [["scan-dead-code", "manual", false], ["grade-rubric", "on completion", false]] }),
        mkSection("testing",     { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false]] }),
        mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
    // ── transform blueprints (#645 slice 2): operate on existing repos ──
    {
      id: "split-services", name: "Split into microservices", desc: "Carve a monolith into services along its seams",
      origin: "built-in", icon: "⧉", h: 230, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",       { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("boundaries",  { pipelines: [["grade-rubric", "on completion", false]] }),
        mkSection("extraction",  { pipelines: [["contract-test", "on completion", true]] }),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false]] }),
        mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
    {
      id: "combine-services", name: "Combine microservices", desc: "Merge services back into fewer (or a monolith)",
      origin: "built-in", icon: "⧈", h: 260, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",         { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("consolidation", { pipelines: [["grade-rubric", "on completion", false]] }),
        mkSection("testing",       { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("structure",     { pipelines: [["generate-issues", "on completion", true]] }),
        mkSection("permissions",   { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
    {
      id: "migrate", name: "Migrate stack", desc: "Move framework / language / protocol with an incremental cutover",
      origin: "built-in", icon: "⇄", h: 195, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",       { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("migration",   { pipelines: [["grade-rubric", "on completion", false]] }),
        mkSection("testing",     { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true]] }),
        mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
    {
      id: "harden", name: "Harden security", desc: "Threat-model, audit, and fix security gaps in place",
      origin: "built-in", icon: "⛨", h: 25, category: "harden", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",       { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("hardening",   { pipelines: [["grade-rubric", "on completion", false]] }),
        mkSection("testing",     { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true]] }),
        mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
  ];
}

export interface SectionStatus { locked: boolean; unmet: string[]; satisfied: boolean }

/**
 * Dependency / lock resolution. A section is LOCKED when it's enabled but a
 * dependency is off or itself locked. A dep this blueprint omits is treated as met.
 */
export function computeStatus(sections: BlueprintSection[]): Record<string, SectionStatus> {
  const byKey: Record<string, BlueprintSection> = Object.fromEntries(sections.map((s) => [s.key, s]));
  const memo: Record<string, boolean> = {};
  function satisfied(key: string, stack: Set<string>): boolean {
    if (key in memo) return memo[key];
    const s = byKey[key];
    if (!s) return true;
    if (!s.enabled) return (memo[key] = false);
    if (stack.has(key)) return true; // cycle guard
    stack.add(key);
    const ok = (s.deps || []).every((d) => satisfied(d, stack));
    stack.delete(key);
    return (memo[key] = ok);
  }
  const out: Record<string, SectionStatus> = {};
  for (const s of sections) {
    const present = (s.deps || []).filter((d) => byKey[d]);
    const unmet = present.filter((d) => !byKey[d].enabled || !satisfied(d, new Set()));
    out[s.key] = { locked: s.enabled && unmet.length > 0, unmet, satisfied: satisfied(s.key, new Set()) };
  }
  return out;
}

/** Move `fromUid` before/after `toUid` in a uid-keyed list (drag-reorder). */
export function reorder<T extends { uid: string }>(arr: T[], fromUid: string, toUid: string, before: boolean): T[] {
  const a = [...arr];
  const fi = a.findIndex((x) => x.uid === fromUid);
  if (fi < 0) return arr;
  const [item] = a.splice(fi, 1);
  let ti = a.findIndex((x) => x.uid === toUid);
  if (ti < 0) { a.push(item); return a; }
  if (!before) ti += 1;
  a.splice(ti, 0, item);
  return a;
}

/** Deep-copy sections with fresh uids (for duplicate). */
export function cloneSections(sections: BlueprintSection[]): BlueprintSection[] {
  return sections.map((s) => ({ ...s, uid: uid("sec"), pipelines: s.pipelines.map((p) => ({ ...p, uid: uid("pl") })) }));
}

/**
 * Derive the per-project StageConfig (enabled + order over the registry's known
 * StageIds) that the planning N-bar reads, from a blueprint's sections. Custom and
 * non-registry sections (e.g. testing) are omitted — they configure planning but
 * don't have a registry gate yet.
 */
/**
 * What to record when a project's planning opens (#647). A brand-new project (no stage
 * config) seeds from + records the active blueprint. An existing project with NO recorded
 * blueprint (planned before blueprint tracking) backfills to the default — so selecting a
 * different blueprint still triggers the reset prompt instead of silently doing nothing.
 * Otherwise the project already knows its blueprint, so nothing changes here.
 */
export function resolveProjectSeed(
  hasConfig: boolean, recordedBlueprintId: string | undefined, activeBlueprintId: string,
): { seedConfig: boolean; setBlueprintId?: string } {
  if (!hasConfig) return { seedConfig: true, setBlueprintId: activeBlueprintId };
  if (!recordedBlueprintId) return { seedConfig: false, setBlueprintId: DEFAULT_BLUEPRINT_ID };
  return { seedConfig: false };
}

export function blueprintToStageConfig(bp: Blueprint): StageConfig {
  const known = new Set<string>(PLAN_STAGES.map((s) => s.id));
  const enabled = Object.fromEntries(PLAN_STAGES.map((s) => [s.id, false])) as Record<StageId, boolean>;
  const order: StageId[] = [];
  for (const s of bp.sections) {
    if (!known.has(s.key)) continue;
    const id = s.key as StageId;
    enabled[id] = s.enabled;
    order.push(id);
  }
  return { enabled, order };
}

// ── Blueprint-driven status (#…) ──────────────────────────────────────────────
// These evaluate a blueprint's sections DIRECTLY against the published signal bag —
// no PLAN_STAGES enum, no per-stage hardcoding. Each section carries its own
// declarative gate (`gateRule`), applicability (`appliesWhen`), and `deps`, so a
// built-in section and a cloud-distributed one are evaluated by the exact same code.
// The progress bar, readiness check, current-section, and the "what's incomplete"
// feedback all read from here.

/** Render status of a blueprint section. `na` = not applicable to this project. */
export type SectionRenderStatus = "locked" | "in-progress" | "complete" | "na";

/** The signal that marks an informational (gateless) section confirmed/complete (#664). */
export const confirmedSignal = (key: string) => `confirmed:${key}`;

/** Whether a section is done. A section WITH a declarative gate uses {@link evalGate}. A
 *  gateless ("informational") section is NOT vacuously complete — it's done only when the
 *  planner confirms it (a `confirmed:<key>` signal), so a fresh/cleared plan shows it as
 *  in-progress rather than ✓ (#664). */
export function sectionDone(section: BlueprintSection, signals: PlanSignals): { done: boolean; fraction: number } {
  if (section.gateRule) return evalGate(section.gateRule, signals);
  const ok = signals[confirmedSignal(section.key)] === true;
  return { done: ok, fraction: ok ? 1 : 0 };
}

/** A dependency is satisfied when the blueprint omits it, it's disabled, it's N/A, or
 *  its own gate is complete. Mirrors the registry's dep rule, but over blueprint data. */
function depSatisfied(depKey: string, byKey: Record<string, BlueprintSection>, signals: PlanSignals): boolean {
  const dep = byKey[depKey];
  if (!dep) return true;        // this blueprint doesn't include the dep
  if (!dep.enabled) return true;
  if (!gateApplies(dep.appliesWhen, signals)) return true;
  return sectionDone(dep, signals).done;
}

/**
 * Resolve a section's render status + bar fill from blueprint data alone: its
 * applicability rule, its declarative gate, and its (included, enabled) dependencies.
 */
export function sectionStatus(
  section: BlueprintSection,
  sections: BlueprintSection[],
  signals: PlanSignals,
): { status: SectionRenderStatus; fraction: number } {
  if (!gateApplies(section.appliesWhen, signals)) return { status: "na", fraction: 0 };
  const g = sectionDone(section, signals);
  if (g.done) return { status: "complete", fraction: 1 };
  const byKey: Record<string, BlueprintSection> = Object.fromEntries(sections.map((s) => [s.key, s]));
  const locked = (section.deps || []).some((d) => !depSatisfied(d, byKey, signals));
  return { status: locked ? "locked" : "in-progress", fraction: g.fraction };
}

/** The enabled sections of a blueprint, in their declared order. */
export function enabledSections(sections: BlueprintSection[]): BlueprintSection[] {
  return sections.filter((s) => s.enabled);
}

/** Whether every enabled, applicable section is complete — the triage readiness gate. */
export function planSectionsComplete(sections: BlueprintSection[], signals: PlanSignals): boolean {
  return enabledSections(sections).every((s) => {
    const { status } = sectionStatus(s, sections, signals);
    return status === "complete" || status === "na";
  });
}

/**
 * The current ("reached") section: the first enabled + applicable section that is
 * in progress. When all are complete it falls back to the last enabled + applicable
 * one. Drives which pipelines' second screens render.
 */
export function currentSection(sections: BlueprintSection[], signals: PlanSignals): BlueprintSection | undefined {
  const applicable = enabledSections(sections).filter((s) => gateApplies(s.appliesWhen, signals));
  const active = applicable.find((s) => sectionStatus(s, sections, signals).status === "in-progress");
  return active ?? applicable[applicable.length - 1];
}

/** A blueprint section that isn't satisfied yet — what the user still has to finish. */
export interface IncompleteSection {
  key: string;
  /** The section's display name, straight from the blueprint. */
  name: string;
  /** The section's own gate description (`gate`) — the human "what's left". */
  reason: string;
  /** Locked behind an unfinished dependency vs. simply in progress. */
  status: "locked" | "in-progress";
}

/**
 * Every enabled section that is not yet complete, in section order, each tagged with
 * its status and the section's own gate description as the reason. Fully blueprint-
 * driven — including unknown / cloud-distributed sections — so adding or reordering a
 * section flows through here with nothing hardcoded per stage. Powers the feedback
 * shown when the user clicks a locked Triage button.
 */
export function incompleteSections(sections: BlueprintSection[], signals: PlanSignals): IncompleteSection[] {
  const out: IncompleteSection[] = [];
  for (const s of enabledSections(sections)) {
    const { status } = sectionStatus(s, sections, signals);
    if (status === "complete" || status === "na") continue;
    out.push({ key: s.key, name: s.name, reason: s.gate, status });
  }
  return out;
}
