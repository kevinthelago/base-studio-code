// Blueprints (#513/#514): the model behind the Blueprints page. A blueprint is an
// ordered list of planning SECTIONS (stages) that seeds every new project. Each
// section owns its prompt module (the instructions Claude receives for that stage)
// and its PIPELINES — pluggable actions that run on the stage's output. Pure (no
// React/Tauri) so it's unit-testable and the store can seed from it directly.
//
// Mirrors design/base-studio-code-projects/Blueprints.html.

import { PLAN_STAGES, type StageConfig, type StageId } from "./planStages";
import { type ClassificationSignals } from "./classification";
import {
  evalGate, gateApplies,
  type StageGate, type Requirement, type PlanSignals,
} from "./stageGate";

// ── ids ──────────────────────────────────────────────────────────────────────
let _id = 0;
/** Ephemeral handle for a section/pipeline instance (stable within a session). */
export const uid = (p: string) => `${p}-${++_id}`;

// The blueprint-stage "pipeline" abstraction was removed in #897 Phase 4c: there was no
// production trigger engine, and the three surviving behaviors — render-preview, grade-plan,
// lint-plan — run by direct dispatch from their own modules. Capability now attaches to a
// blueprint as skills (#636) + MCP servers (#897); app-actions are the section `output`
// disposition + handlePublish.

// ── Substeps ─────────────────────────────────────────────────────────────────
// A discrete step WITHIN a stage. The conductor injects ONE substep's prompt at a time and
// advances when its artifact is written + confirmed — incremental, instead of front-loading
// the whole stage's instructions. A `loop` substep repeats once per dynamic item discovered
// during the stage (the feature workshop), so the conductor drives "one feature at a time".
export type SubStepLoop = "features" | "repos" | "topics";
export interface SubStep {
  /** Canonical key / artifact stem (e.g. "goal" → goal.md). For a loop, the loop's id. */
  key: string;
  label: string;
  /** Injected into the session when this substep becomes active. Plan-only — never describes
   *  publishing (the user owns that). */
  prompt: string;
  /** Human "done when…"; absent ⇒ informational (no gate of its own). */
  gate?: string;
  /** Repeat once per dynamic item (a feature, a repo). Absent ⇒ a single static substep. */
  loop?: SubStepLoop;
}

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
  /** An OPTIONAL section is shown but never required: it doesn't block plan completion or
   *  downstream dependents, and it's off the critical path (currentSection skips it) — the
   *  user can fill it or skip it (#676). */
  optional?: boolean;
  /** Context stage only (#1019): the baseline REQUIRED topics this section seeds into the project's
   *  dynamic context manifest (plan.db) when first adopted. The planner then adjusts the set with
   *  `bsc-plan context require/unrequire`. Absent ⇒ the universal {@link CONTEXT_BASELINE}. */
  requires?: string[];
  /** Output disposition (#609) — what happens to this stage's artifact (a key into
   *  DISPOSITIONS: plan-file / issues / milestones / skill-index / knowledge / scratch).
   *  Editor metadata; the runtime doesn't read it. Absent ⇒ defaultDisposition(key). */
  output?: string;
  /** Attached skills/knowledge (#636) — library item ids (KB blocks or Skills) injected
   *  into the agent's context for this stage. Resolved at planning + fleet launch
   *  (slice b). Reference-by-id; unresolved ids surface a warning. */
  skills?: string[];
  /** Attached MCP servers (#897) — server NAMES (the portable ref, matching the catalog +
   *  `<mcp_assign>`), scoped to the project at launch so the planner/fleet can call them.
   *  Kept SEPARATE from `skills`: MCP servers are tools (research/analysis/grading), skills are
   *  knowledge. Reference-by-name; an unresolved name surfaces a warning in the editor. */
  mcp?: string[];
  /** Ordered substeps the conductor injects one at a time (#…). Absent ⇒ the stage is driven
   *  by a single prompt (its `prompt`). Pipeline `triggerTarget`s reference these by `key`. */
  substeps?: SubStep[];
  /** The planner-facing directive prose (#1462) — the single source of truth, shared byte-for-byte
   *  with the Rust `stage_directive`, read from this stage's `prompts/stages/<id>.json`. Only the
   *  duplicated stages carry one; stages without it use the generic Rust fallback. */
  directive?: string;
  /** Reserved (populated by #1395) — the classification signals that gate this stage's applicability,
   *  and its ordering tier. Typed now so #1395 fills them without re-churning files; unset today. */
  signals?: ClassificationSignals;
  phase?: "discover" | "decide" | "generate";
}

// The canonical planning-stage data lives as one JSON file per stage under src-tauri/prompts/stages/
// (one file per key), the unified prompt-data root (#1462). Loaded + assembled into SECTION_DEFS here.
const sectionModules = import.meta.glob<{ default: SectionDef }>("@prompts/stages/*.json", { eager: true });

/** Every section definition, keyed by its filename stem (= the section key). */
export const SECTION_DEFS: Record<string, SectionDef> = Object.fromEntries(
  Object.entries(sectionModules).map(([path, mod]) => [path.slice(path.lastIndexOf("/") + 1, -5), mod.default]),
);

export interface BlueprintSection extends SectionDef {
  uid: string;
  key: string;
  enabled: boolean;
  expanded: boolean;
}

/** Where a blueprint came from (#609) — drives the card's origin tag. */
export type BlueprintOrigin = "built-in" | "local" | "forked" | "imported";

/** Lifecycle intent of a blueprint (#645) — what part of a project's life it serves.
 *  Greenfield = create from a pitch; transform = restructure existing repos; harden =
 *  improve quality in place; maintain = ongoing upkeep. Drives library grouping/labels. */
export type BlueprintCategory = "greenfield" | "transform" | "harden" | "maintain" | "data";
export const BLUEPRINT_CATEGORIES: BlueprintCategory[] = ["greenfield", "transform", "harden", "maintain", "data"];

/** Whether a blueprint starts from a pitch (create) or runs against existing repos
 *  (operate) — selects the planner intro at launch. */
export type BlueprintMode = "create" | "operate";

/** Display metadata per category (label + accent hue for the badge/filter). */
export const CATEGORY_META: Record<BlueprintCategory, { label: string; h: number }> = {
  greenfield: { label: "Greenfield", h: 145 },
  transform:  { label: "Transform",  h: 230 },
  harden:     { label: "Harden",     h: 25 },
  maintain:   { label: "Maintain",   h: 70 },
  // Data-acquisition blueprints (#779) — distinct from the software-lifecycle
  // categories above. They write into a canonical Data Model rather than code.
  data:       { label: "Data",       h: 280 },
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
  /** The upstream gist's `updated_at` recorded at import/sync. Compared against the gist's CURRENT
   *  `updated_at` on the import-from-gist page to detect an available update (#955). */
  updatedAt?: string;
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
  /** Blueprint-wide attached MCP servers (#897) — applied across every stage, in addition to
   *  each section's own `mcp`. Server NAMES (the portable ref). */
  mcp?: string[];
  /** Lifecycle intent (#645). Absent ⇒ greenfield (the create-a-project default). */
  category?: BlueprintCategory;
  /** Create (from a pitch) vs operate (against existing repos). Absent ⇒ create. */
  mode?: BlueprintMode;
  /** Authoring metadata (#923, blueprint-author design): a one-line catalog pitch, the audience it
   *  serves, and the publish visibility. `tags` doubles as the design's "best for" catalog tags. */
  pitch?: string;
  audience?: string;
  visibility?: "local" | "private-gist" | "catalog";
  /** Deliverable / output lifecycle (#923). Absent ⇒ the normal software deliverable: the planner
   *  publishes repos + a project board + milestones + issues, then a fleet builds them. `"blueprint"`
   *  marks an AUTHORING lifecycle — the planner designs a reusable blueprint and "publish" ships it
   *  to a gist; there is no code, so no fleet and no triage (see `isAuthoringBlueprint`). */
  deliverable?: "blueprint";
}

/** The built-in blueprint-author lifecycle's id (#923). */
export const AUTHORING_BLUEPRINT_ID = "blueprint-author";

/** Whether a blueprint's deliverable is a blueprint itself (#923) — the authoring lifecycle:
 *  publish → gist, and no fleet / triage. */
export function isAuthoringBlueprint(bp: Blueprint | undefined): boolean {
  return bp?.deliverable === "blueprint";
}

/** Whether a project bound to this blueprint may switch to a different one AT ALL (#1281). ANY
 *  project-lifecycle blueprint can switch now — the confirmation modal (reset / keep / export) is the
 *  safety, not a category rule. Only the locked blueprint-AUTHORING lifecycle stays put (it designs a
 *  blueprint, it doesn't seed a project). Drives whether a "switch blueprint" affordance is offered.
 *  (Replaces the #923 greenfield-only rule, which soft-locked a project the moment it left greenfield.) */
export function canChangeBlueprint(bp: Blueprint | undefined): boolean {
  return !!bp && !isAuthoringBlueprint(bp);
}

/** Whether a project currently on `from` may switch to a `to` blueprint (#1281). ANY project blueprint
 *  → any OTHER project blueprint is allowed; the user confirms each switch via the reset/keep/export
 *  modal. Refused only when: either side is missing, either is the blueprint-authoring lifecycle, or
 *  it's the same blueprint (a no-op). This is the authoritative switch gate. */
export function canSwitchBlueprint(from: Blueprint | undefined, to: Blueprint | undefined): boolean {
  if (!from || !to) return false;
  if (isAuthoringBlueprint(from) || isAuthoringBlueprint(to)) return false;
  return from.id !== to.id;
}

/** The gate signals the blueprint-authoring stages read, derived from the in-progress blueprint the
 *  planner is designing (#923, gates per the blueprint-author design):
 *  - `bpName` — Purpose gate: name + pitch + ≥1 catalog tag.
 *  - `bpStageCount` — how many stages (display).
 *  - `bpStagesReady` — Stages gate: ≥2 stages, each with a prompt module written.
 *  - `bpValid` — Review gate: every publish check passes (identity + stages + prompts).
 *  Pure; mirrors the design's validation without importing the editor. */
export function authoringSignals(bp: Blueprint | undefined): Record<string, number | boolean> {
  const sections = bp?.sections ?? [];
  const hasName = !!bp?.name?.trim();
  const hasPitch = !!bp?.pitch?.trim();
  const hasTag = (bp?.tags?.length ?? 0) > 0;
  const enoughStages = sections.length >= 2;
  const everyPrompt = sections.length > 0 && sections.every((s) => !!s.prompt?.trim());
  return {
    bpName: hasName && hasPitch && hasTag,
    bpStageCount: sections.length,
    bpStagesReady: enoughStages && everyPrompt,
    bpValid: hasName && hasPitch && hasTag && enoughStages && everyPrompt,
  };
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

/** Fold an adjacent SectionDef INTO `base` as a second substep — one merged stage gated on BOTH
 *  halves, with the folded def's prompt as the second substep. The folded SectionDef stays the
 *  single source (gate + prompt); a blueprint that doesn't opt in is untouched. Shared by the
 *  Deploy→Repos ("ship", #1383) and Permissions→Structure ("fleet", #1383-streams) merges. */
function foldInto(
  base: BlueprintSection, def: SectionDef, folded: SectionDef | undefined,
  name: string, subs: [string, string][],
): BlueprintSection {
  if (!folded) return base;
  // Preserve the base section's OWN substeps (e.g. Structure's "sequence"); a base with none gets a
  // synthesized first substep from its prompt. Then append the folded section as the marker substep
  // (its key — "ship"/"fleet" — is what the focused-pane detects to render the merged body).
  const baseSubs = base.substeps ?? [{ key: subs[0][0], label: subs[0][1], prompt: def.prompt }];
  return {
    ...base,
    name,
    gate: `${def.gate} · ${folded.gate}`,
    gateRule: { require: [...(def.gateRule?.require ?? []), ...(folded.gateRule?.require ?? [])] },
    output: folded.output ?? base.output,
    substeps: [...baseSubs, { key: subs[1][0], label: subs[1][1], prompt: folded.prompt }],
  };
}

/** Build a section instance from a def key + per-blueprint overrides. */
export function mkSection(
  key: string,
  { enabled = true, expanded = false, optional, ship, fleet }:
    { enabled?: boolean; expanded?: boolean; optional?: boolean; ship?: boolean; fleet?: boolean } = {},
): BlueprintSection {
  const def = SECTION_DEFS[key];
  const base: BlueprintSection = {
    uid: uid("sec"), key, ...def, enabled, expanded,
    // explicit `optional` overrides the def's; otherwise inherit it
    optional: optional ?? def.optional,
  };
  // A blueprint can fold an adjacent stage INTO this one as a substep — one merged stage gated on
  // BOTH halves, only where the blueprint opts in. The folded SectionDef stays the single source, so
  // blueprints that don't opt in are untouched (no behavior change).
  // #1383: Deploy → Repos ("ship"). #1383-streams: Permissions → Structure ("fleet" → "Streams").
  if (ship) return foldInto(base, def, SECTION_DEFS.deploy, "Deployment", [["link", "Link repositories"], ["ship", "Define deployment"]]);
  if (fleet) return foldInto(base, def, SECTION_DEFS.permissions, "Streams", [["plan", "Plan the roadmap"], ["fleet", "Plan the fleet"]]);
  return base;
}

/** The planner-overview directive id for a (possibly merged) section (#1383/#1392). A merged stage
 *  reads as ONE directive in the planner's "Active planning stages" scope: a `repos` section with a
 *  `ship` substep → `repos_deploy` ("Deployment"), a `structure` section with a `fleet` substep →
 *  `streams` ("Streams"). Plain (unmerged) sections map to their own key. Pure so the planner-scope
 *  build is testable; `stageIdsFor` (Planning.tsx) passes the result to `setup_workspaces`. */
export function stageDirectiveId(section: { key: string; substeps?: SubStep[] }): string {
  const subs = (section.substeps ?? []).map((s) => s.key);
  if (section.key === "repos" && subs.includes("ship")) return "repos_deploy";
  if (section.key === "structure" && subs.includes("fleet")) return "streams";
  return section.key;
}

/** Seed blueprints — the starter library, depicting every section/pipeline state. */
/**
 * Replace persisted built-in blueprints with their current code definitions (by id) and
 * append any new built-ins, leaving user-created / forked / imported blueprints untouched.
 * Built-ins are code-owned templates, but `blueprints` is persisted — this lets improvements
 * (the optional UI stage, enabled repos, updated prompts, …) reach an already-seeded store
 * instead of being pinned to the version a user first ran (#677).
 */
export function refreshBuiltIns(persisted: Blueprint[]): Blueprint[] {
  const fresh = makeBlueprints();
  const byId = new Map(fresh.map((b) => [b.id, b]));
  // Drop persisted built-ins that no longer exist in code (removed templates), refresh the rest by
  // id, and leave user-created / forked / imported blueprints untouched (#923 cleanup).
  const merged = persisted
    .filter((b) => b.origin !== "built-in" || byId.has(b.id))
    .map((b) => (b.origin === "built-in" && byId.has(b.id) ? byId.get(b.id)! : b));
  for (const b of fresh) if (!merged.some((x) => x.id === b.id)) merged.push(b);
  return merged;
}

/** The JSON shape of a built-in blueprint definition (stages/blueprints/*.json): blueprint
 *  metadata + an ordered list of section KEYS (chaining to stages/sections/*.json). The keys
 *  resolve to full section instances via mkSection at load — no blueprint data lives in TS. */
export interface BlueprintDef extends Omit<Blueprint, "sections"> {
  /** Display order within the built-in library. */
  order?: number;
  /** Ordered section refs: a key into SECTION_DEFS + an optional per-blueprint `optional` flag, plus
   *  `ship` (#1383, on the `repos` ref → folds Deploy in) and `fleet` (on the `structure` ref →
   *  folds Permissions in, making the "Streams" stage). */
  sections: { key: string; optional?: boolean; ship?: boolean; fleet?: boolean }[];
}

// The built-in blueprints live as one JSON file per blueprint under ./blueprints/ — each is just
// metadata + an ordered list of section keys that chain into ./sections/*.json (resolved below).
const blueprintModules = import.meta.glob<{ default: BlueprintDef }>("@prompts/blueprints/*.json", { eager: true });

/** The built-in blueprint library, assembled from the per-blueprint JSON definitions: ordered by
 *  each def`s `order`, with its section keys resolved into section instances via mkSection. */
export function makeBlueprints(): Blueprint[] {
  return Object.values(blueprintModules)
    .map((m) => m.default)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(({ order: _order, sections, ...meta }) => ({
      ...meta,
      sections: sections.map((s) => mkSection(s.key, { optional: s.optional, ship: s.ship, fleet: s.fleet })),
    }));
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
  return sections.map((s) => ({ ...s, uid: uid("sec") }));
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

/** The signal that marks an OPTIONAL section the user deliberately SKIPPED (#921). A skipped
 *  section counts as resolved — the flow advances past it and it never blocks completion — but
 *  it renders distinctly ("skipped", not "complete"). */
export const skippedSignal = (key: string) => `skipped:${key}`;

/** Whether a section is done/resolved. A user-SKIPPED section (#921) is resolved regardless of
 *  its gate. Otherwise: a section WITH a declarative gate uses {@link evalGate}; a gateless
 *  ("informational") section is done only when confirmed (a `confirmed:<key>` signal), so a
 *  fresh/cleared plan shows it as in-progress rather than ✓ (#664). */
export function sectionDone(section: BlueprintSection, signals: PlanSignals): { done: boolean; fraction: number } {
  if (signals[skippedSignal(section.key)] === true) return { done: true, fraction: 1 };
  if (section.gateRule) return evalGate(section.gateRule, signals);
  const ok = signals[confirmedSignal(section.key)] === true;
  return { done: ok, fraction: ok ? 1 : 0 };
}

/** Whether a section was resolved by a deliberate user SKIP (vs genuinely completed) — drives the
 *  distinct "skipped" rendering. (#921) */
export function sectionSkipped(section: BlueprintSection, signals: PlanSignals): boolean {
  return signals[skippedSignal(section.key)] === true;
}

/** A dependency is satisfied when the blueprint omits it, it's disabled, it's N/A, or
 *  its own gate is complete. Mirrors the registry's dep rule, but over blueprint data. */
function depSatisfied(depKey: string, byKey: Record<string, BlueprintSection>, signals: PlanSignals): boolean {
  const dep = byKey[depKey];
  if (!dep) return true;        // this blueprint doesn't include the dep
  if (!dep.enabled) return true;
  if (dep.optional) return true;        // optional deps never block dependents (#676)
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
  // An optional section is always shown (it bypasses appliesWhen) — it's just never
  // required; non-optional sections still go N/A when their applicability rule fails (#676).
  if (!section.optional && !gateApplies(section.appliesWhen, signals)) return { status: "na", fraction: 0 };
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

/** Whether every enabled, applicable section is resolved — the triage readiness gate. An OPTIONAL
 *  section must be DECIDED (completed or user-skipped) just like a required one; a user-skip marks
 *  it done (#921). This is what lets the user, not the app, decide whether to skip an optional
 *  stage — the plan isn't "complete" until each enabled optional stage has been addressed. */
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
  // The flow STOPS on an optional stage too, so the USER decides whether to do or skip it (#921) —
  // a skipped optional section is `sectionDone` ⇒ not "in-progress", so the frontier advances past
  // it. Optional sections bypass `appliesWhen` (always shown), matching `sectionStatus`.
  const applicable = enabledSections(sections).filter((s) => s.optional || gateApplies(s.appliesWhen, signals));
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

// ── Blueprint/template-change detection (#827/#1296) ──────────────────────────
// The context signature (planner/workspace.rs `context_signature`) is `v{TEMPLATE_VERSION}|
// repos|kb|stages`. Its FIRST `|`-delimited field is the blueprint/planner-template version;
// the rest is per-project SETUP (linked repos, KB blocks, enabled stages). A genuine
// "the blueprint has changed" event — the only thing that should auto-open the destructive
// BlueprintUpdateModal — is a change to that version field. Mere setup tweaks (link a repo,
// toggle a KB block, enable/disable a stage) change the later fields and drive only the quiet
// "context updated · refresh" badge, NOT the modal (#1296).

/** The blueprint/planner-template version component of a context signature (everything before
 *  the first `|`), or "" when the signature is empty/absent. */
export function signatureTemplateVersion(sig: string | null | undefined): string {
  if (!sig) return "";
  const bar = sig.indexOf("|");
  return bar === -1 ? sig : sig.slice(0, bar);
}

/** True only when two non-empty signatures carry DIFFERENT template-version prefixes — i.e. the
 *  blueprint/planner template was genuinely updated, not just the linked repos / KB / stages. */
export function blueprintTemplateChanged(currentSig: string | null | undefined, baselineSig: string | null | undefined): boolean {
  const cur = signatureTemplateVersion(currentSig);
  const base = signatureTemplateVersion(baselineSig);
  return !!cur && !!base && cur !== base;
}

/**
 * Whether the destructive "this project's blueprint has changed" modal should AUTO-open (#1296).
 * Gated on a true template-version mismatch (`blueprintTemplateChanged`) — never on benign setup
 * tweaks — plus an existing plan to protect, and the once-per-open `alreadyShown` guard.
 */
export function shouldAutoOpenBlueprintModal(args: {
  currentSig: string | null | undefined;
  baselineSig: string | null | undefined;
  hasExistingPlan: boolean;
  alreadyShown: boolean;
}): boolean {
  return blueprintTemplateChanged(args.currentSig, args.baselineSig)
    && args.hasExistingPlan
    && !args.alreadyShown;
}
