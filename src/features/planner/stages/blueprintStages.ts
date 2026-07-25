// Pure blueprint/stage HELPERS (#513/#514, split out #2148): the functions over blueprint +
// section data — the authoring-lifecycle checks, category filtering, section/dep/lock resolution,
// the built-in refresh/merge, the blueprint-driven stage status + progress engine, and the
// template-change detection. Pure (no React/Tauri). Types live in blueprintTypes.ts; the packaged
// data + library assembly in blueprintBuiltins.ts.

import { PLAN_STAGES, type StageConfig, type StageId } from "./planStages";
import { evalGate, gateApplies, type PlanSignals } from "./stageGate";
import type {
  Blueprint, BlueprintStage, BlueprintCategory, SectionStatus,
  StageRenderStatus, IncompleteStage, SectionDef, ModelCapabilityTier, StageSeed,
} from "./blueprintTypes";
import { uid, makeBlueprints, dedupeSections } from "./blueprintBuiltins";

// ── Dynamic-blueprint resolution (#1854 Phase a) ──────────────────────────────

/** Resolve the prompt to use for a stage, adapting to the driving model's capability tier (#1854
 *  Phase a). When a `tier` is given and the stage declares a {@link SectionDef.promptVariants}
 *  override for exactly that tier, that variant wins; otherwise the stage's base `prompt` is used —
 *  so a stage with no variants (or no tier) behaves exactly as today (the base prompt). The lookup is
 *  DIRECT (no cross-tier cascade): an absent variant falls straight back to the base `prompt`, which
 *  is already the open-ended frontier prompt. Returns "" for a missing section. */
export function resolveStagePrompt(
  section: Pick<SectionDef, "prompt" | "promptVariants"> | undefined,
  tier?: ModelCapabilityTier,
): string {
  if (!section) return "";
  const variant = tier ? section.promptVariants?.[tier] : undefined;
  return variant?.trim() ? variant : section.prompt;
}

/** The archetype seed content for a stage, or undefined when the stage carries none (#1854 Phase a).
 *  A convenience accessor so callers don't reach into `section.seed` (and so an empty/whitespace
 *  `content` is treated as absent). */
export function stageSeed(section: Pick<SectionDef, "seed"> | undefined): StageSeed | undefined {
  const seed = section?.seed;
  return seed?.content?.trim() ? seed : undefined;
}

/** Whether a project bound to this blueprint may switch to a different one AT ALL (#1281). ANY
 *  project-lifecycle blueprint can switch — the confirmation modal (reset / keep / export) is the
 *  safety, not a category rule. Drives whether a "switch blueprint" affordance is offered. */
export function canChangeBlueprint(bp: Blueprint | undefined): boolean {
  return !!bp;
}

/** Whether a project currently on `from` may switch to a `to` blueprint (#1281). ANY project blueprint
 *  → any OTHER project blueprint is allowed; the user confirms each switch via the reset/keep/export
 *  modal. Refused only when either side is missing or it's the same blueprint (a no-op). This is the
 *  authoritative switch gate. */
export function canSwitchBlueprint(from: Blueprint | undefined, to: Blueprint | undefined): boolean {
  if (!from || !to) return false;
  return from.id !== to.id;
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
    // Built-ins are replaced by their fresh code def; everything else is a persisted
    // user/forked/imported blueprint — dedup its section keys defensively.
    .map((b) => (b.origin === "built-in" && byId.has(b.id) ? byId.get(b.id)! : { ...b, sections: dedupeSections(b.sections) }));
  for (const b of fresh) if (!merged.some((x) => x.id === b.id)) merged.push(b);
  return merged;
}

/**
 * Dependency / lock resolution. A section is LOCKED when it's enabled but a
 * dependency is off or itself locked. A dep this blueprint omits is treated as met.
 */
export function computeStatus(sections: BlueprintStage[]): Record<string, SectionStatus> {
  const byKey: Record<string, BlueprintStage> = Object.fromEntries(sections.map((s) => [s.key, s]));
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
export function cloneStages(sections: BlueprintStage[]): BlueprintStage[] {
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
export function stageDone(section: BlueprintStage, signals: PlanSignals): { done: boolean; fraction: number } {
  if (signals[skippedSignal(section.key)] === true) return { done: true, fraction: 1 };
  if (section.gateRule) return evalGate(section.gateRule, signals);
  const ok = signals[confirmedSignal(section.key)] === true;
  return { done: ok, fraction: ok ? 1 : 0 };
}

/** Whether a section was resolved by a deliberate user SKIP (vs genuinely completed) — drives the
 *  distinct "skipped" rendering. (#921) */
export function stageSkipped(section: BlueprintStage, signals: PlanSignals): boolean {
  return signals[skippedSignal(section.key)] === true;
}

/** A dependency is satisfied when the blueprint omits it, it's disabled, it's N/A, or
 *  its own gate is complete. Mirrors the registry's dep rule, but over blueprint data. */
function depSatisfied(depKey: string, byKey: Record<string, BlueprintStage>, signals: PlanSignals): boolean {
  const dep = byKey[depKey];
  if (!dep) return true;        // this blueprint doesn't include the dep
  if (!dep.enabled) return true;
  if (dep.optional) return true;        // optional deps never block dependents (#676)
  if (!gateApplies(dep.appliesWhen, signals)) return true;
  return stageDone(dep, signals).done;
}

/**
 * Resolve a section's render status + bar fill from blueprint data alone: its
 * applicability rule, its declarative gate, and its (included, enabled) dependencies.
 */
export function stageStatus(
  section: BlueprintStage,
  sections: BlueprintStage[],
  signals: PlanSignals,
): { status: StageRenderStatus; fraction: number } {
  // An optional section is always shown (it bypasses appliesWhen) — it's just never
  // required; non-optional sections still go N/A when their applicability rule fails (#676).
  if (!section.optional && !gateApplies(section.appliesWhen, signals)) return { status: "na", fraction: 0 };
  const g = stageDone(section, signals);
  if (g.done) return { status: "complete", fraction: 1 };
  const byKey: Record<string, BlueprintStage> = Object.fromEntries(sections.map((s) => [s.key, s]));
  const locked = (section.deps || []).some((d) => !depSatisfied(d, byKey, signals));
  return { status: locked ? "locked" : "in-progress", fraction: g.fraction };
}

/** The enabled sections of a blueprint, in their declared order. */
export function enabledStages(sections: BlueprintStage[]): BlueprintStage[] {
  return sections.filter((s) => s.enabled);
}

/** Whether every enabled, applicable section is resolved — the triage readiness gate. An OPTIONAL
 *  section must be DECIDED (completed or user-skipped) just like a required one; a user-skip marks
 *  it done (#921). This is what lets the user, not the app, decide whether to skip an optional
 *  stage — the plan isn't "complete" until each enabled optional stage has been addressed. */
export function planStagesComplete(sections: BlueprintStage[], signals: PlanSignals): boolean {
  return enabledStages(sections).every((s) => {
    const { status } = stageStatus(s, sections, signals);
    return status === "complete" || status === "na";
  });
}

/**
 * The current ("reached") section: the first enabled + applicable section that is
 * in progress. When all are complete it falls back to the last enabled + applicable
 * one. Drives which pipelines' second screens render.
 */
export function currentStage(sections: BlueprintStage[], signals: PlanSignals): BlueprintStage | undefined {
  // The flow STOPS on an optional stage too, so the USER decides whether to do or skip it (#921) —
  // a skipped optional section is `stageDone` ⇒ not "in-progress", so the frontier advances past
  // it. Optional sections bypass `appliesWhen` (always shown), matching `stageStatus`.
  const applicable = enabledStages(sections).filter((s) => s.optional || gateApplies(s.appliesWhen, signals));
  const active = applicable.find((s) => stageStatus(s, sections, signals).status === "in-progress");
  return active ?? applicable[applicable.length - 1];
}

/**
 * Every enabled section that is not yet complete, in section order, each tagged with
 * its status and the section's own gate description as the reason. Fully blueprint-
 * driven — including unknown / cloud-distributed sections — so adding or reordering a
 * section flows through here with nothing hardcoded per stage. Powers the feedback
 * shown when the user clicks a locked Triage button.
 */
export function incompleteStages(sections: BlueprintStage[], signals: PlanSignals): IncompleteStage[] {
  const out: IncompleteStage[] = [];
  for (const s of enabledStages(sections)) {
    const { status } = stageStatus(s, sections, signals);
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
