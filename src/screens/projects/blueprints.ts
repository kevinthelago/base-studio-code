// Blueprints (#513/#514): the model behind the Blueprints page. A blueprint is an
// ordered list of planning SECTIONS (stages) that seeds every new project. Each
// section owns its prompt module (the instructions Claude receives for that stage)
// and its PIPELINES — pluggable actions that run on the stage's output. Pure (no
// React/Tauri) so it's unit-testable and the store can seed from it directly.
//
// Mirrors design/base-studio-code-projects/Blueprints.html.

import { PLAN_STAGES, type StageConfig, type StageId } from "./planStages";

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
}

export const PIPELINE_LIB: PipelineDef[] = [
  { id: "render-preview",  name: "Render preview",      desc: "Visualize screens as a 2D / 3D walkthrough", suits: ["ui"],          kind: "builtin"  },
  { id: "push-figma",      name: "Push to Figma",       desc: "Export generated frames to a Figma file",    suits: ["ui"],          kind: "external" },
  { id: "generate-issues", name: "Generate issues",     desc: "Turn phases into granular GitHub issues",    suits: ["structure"],   kind: "builtin"  },
  { id: "sync-milestones", name: "Sync milestones",     desc: "Publish phases as GitHub milestones",        suits: ["structure"],   kind: "builtin"  },
  { id: "lint-plan",       name: "Lint plan",           desc: "Validate this stage's output for gaps",      suits: ["*"],           kind: "builtin"  },
  { id: "scope-streams",   name: "Scope streams",       desc: "Derive least-privilege agent profiles",      suits: ["permissions"], kind: "builtin"  },
  { id: "arm-schedule",    name: "Arm schedule",        desc: "Install a cron automation rule",             suits: ["automations"], kind: "builtin"  },
  { id: "sync-skills",     name: "Sync skill library",  desc: "Upsert reusable skills into the library",    suits: ["skills"],      kind: "builtin"  },
  { id: "index-repos",     name: "Clone & index repos", desc: "Clone linked repos and build a code index",  suits: ["repos"],       kind: "builtin"  },
  { id: "export-notion",   name: "Export to Notion",    desc: "Mirror this stage's doc into a Notion page", suits: ["*"],           kind: "external" },
];

// ── Sections (the canonical planning stages) ─────────────────────────────────
export interface SectionDef {
  name: string;
  glyph: string;
  gate: string;
  deps: string[];
  blurb: string;
  prompt: string;
}

export const SECTION_DEFS: Record<string, SectionDef> = {
  context: {
    name: "Context", glyph: "◆", gate: "all topics resolved", deps: [],
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
    blurb: "Link the repositories this project spans.",
    prompt:
`Link the repositories this project spans. For each, record owner/repo, default
branch, and its role in the system. Write repos.json.

Gate: at least one repository is linked.`,
  },
  ui: {
    name: "UI", glyph: "▣", gate: "screens & flows defined", deps: ["context"],
    blurb: "Screens, states, and primary flows.",
    prompt:
`Define the screens and primary flows. For each screen: its purpose, key states,
and the components it needs from the design system. Produce ui.md plus a screen
inventory the Render preview pipeline can visualize.

Gate: every primary flow has its screens and states defined.`,
  },
  structure: {
    name: "Structure", glyph: "⊞", gate: "phases + issues", deps: ["context", "repos", "ui"],
    blurb: "Phases (milestones) and agent-ready issues.",
    prompt:
`Map features into phases (milestones) and granular, agent-ready issues. Each
issue carries acceptance criteria, owned files/globs, dependencies, labels, and
its owning stream — enough that an agent finishes without asking. Write
phases.json and issues.json.

Gate: every phase has issues; every issue is agent-ready.`,
  },
  permissions: {
    name: "Permissions", glyph: "⛉", gate: "every stream scoped", deps: ["context"],
    blurb: "Least-privilege profile per work stream.",
    prompt:
`For every work stream, derive a least-privilege profile: allowed commands,
write-path globs, network access, and a git/gh push policy. Map each to a role
(worker / director / triage). Write the per-stream permission set.

Gate: every stream has a scoped profile and a role.`,
  },
  automations: {
    name: "Automations", glyph: "⚡", gate: "≥1 automation armed", deps: ["context"],
    blurb: "Cron rules that load context or dispatch commands.",
    prompt:
`Propose cron-triggered rules that load a knowledge block or dispatch a command
into a console pane. Record each rule's trigger, target pane, and cadence. Write
automations.md.

Gate: at least one automation is armed.`,
  },
  skills: {
    name: "Skills", glyph: "✦", gate: "skills selected", deps: [],
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
};

export interface BlueprintSection extends SectionDef {
  uid: string;
  key: string;
  enabled: boolean;
  expanded: boolean;
  pipelines: Pipeline[];
}

export interface Blueprint {
  id: string;
  name: string;
  desc: string;
  sections: BlueprintSection[];
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
      id: "default", name: "Default", desc: "Balanced starting point",
      sections: [
        mkSection("context",     { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("repos",       { enabled: false, pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("ui",          { pipelines: [["render-preview", "on artifact change", true], ["push-figma", "on completion", true]] }),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true], ["sync-milestones", "on completion", false]] }),
        mkSection("permissions", { pipelines: [] }),
        mkSection("automations", { pipelines: [["arm-schedule", "on completion", true]] }),
        mkSection("skills",      { pipelines: [["sync-skills", "manual", true]] }),
      ],
    },
    {
      id: "fullstack", name: "Full-stack web app", desc: "Web client + API + DB",
      sections: [
        mkSection("context"), mkSection("repos"), mkSection("ui", { pipelines: [["render-preview", "on artifact change", true]] }),
        mkSection("structure", { pipelines: [["generate-issues", "on completion", true]] }),
        mkSection("testing"), mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
        mkSection("automations"), mkSection("skills"),
      ],
    },
    {
      id: "mobile", name: "Mobile MVP", desc: "Single app, ship fast",
      sections: [
        mkSection("context"), mkSection("ui", { pipelines: [["render-preview", "on artifact change", true]] }),
        mkSection("structure", { pipelines: [["generate-issues", "on completion", true]] }),
        mkSection("permissions"), mkSection("skills"),
      ],
    },
    {
      id: "api", name: "API microservice", desc: "Headless service, no UI",
      sections: [
        mkSection("context"), mkSection("repos"),
        mkSection("structure", { pipelines: [["generate-issues", "on completion", true], ["sync-milestones", "on completion", true]] }),
        mkSection("testing"), mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
        mkSection("automations"),
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
