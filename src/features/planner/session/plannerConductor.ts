// The planning conductor (#…): drives the planner step by step. Instead of front-loading the
// whole spec, the app injects ONE prompt at a time — the active stage's prompt for orientation,
// then each of its substeps in turn, AND for a loop substep (the feature workshop) it steps
// through the items one by one as each completes. This file is the pure decision ("what to
// inject next"); the wiring (pty_write + idle timing + the injected-once guard + building the
// ConductorState) lives in Planning.tsx. No React/Tauri — unit-testable.
import type { BlueprintSection } from "../stages/blueprints";

export interface StagePrompt {
  /** Human label for the picker row (the stage name, or a substep's label/key). */
  label: string;
  /** The full prompt text to inject when the user picks it. */
  text: string;
}

/**
 * The injectable prompts for a stage, surfaced in the focused pane's "?" helper so the USER can
 * pick what to inject (the app no longer auto-injects). The stage's own overview prompt comes
 * first, then each substep's prompt in order. Prompts that are empty/whitespace are skipped.
 */
export function stagePrompts(section: BlueprintSection | undefined): StagePrompt[] {
  if (!section) return [];
  const out: StagePrompt[] = [];
  if (section.prompt?.trim()) out.push({ label: `${section.name} — overview`, text: section.prompt });
  for (const sub of section.substeps ?? []) {
    if (sub.prompt?.trim()) out.push({ label: sub.label || sub.key, text: sub.prompt });
  }
  return out;
}

export interface Injection {
  /** Stable id for the injected-once guard. Forms: `${stage}:_stage`, `${stage}:${substep}`,
   *  or `${stage}:${substep}:${itemId}` for one iteration of a loop substep. */
  id: string;
  prompt: string;
}

export interface LoopItem {
  id: string;
  label: string;
  /** Whether this item is fully done (e.g. a feature with behavior + acceptance). */
  done: boolean;
}

export interface ConductorState {
  /** Static substep keys considered complete — a confirmed discovery section, or a synthetic
   *  marker like "propose" (set once the feature list exists). */
  doneSubsteps: Set<string>;
  /** Ordered items for each loop substep, keyed by the substep key (e.g. "features"). */
  loops: Record<string, LoopItem[]>;
}

/**
 * The next prompt to inject for the active stage, or null if nothing is pending right now.
 *
 * Order per stage: the stage's `prompt` first (orientation), then each substep in turn. A static
 * substep is injected once and blocks until `state.doneSubsteps` marks it complete. A LOOP substep
 * (e.g. the feature workshop) injects its instructions once, then steps through `state.loops[key]`
 * one undone item at a time — injecting a concise pointer per item and waiting for it to finish
 * before advancing. `injected` is the set of ids already sent, so each step fires exactly once.
 */
export function nextInjection(
  section: BlueprintSection | undefined,
  injected: Set<string>,
  state: ConductorState,
): Injection | null {
  if (!section) return null;

  const stageId = `${section.key}:_stage`;
  if (!injected.has(stageId)) return { id: stageId, prompt: section.prompt };

  for (const sub of section.substeps ?? []) {
    if (sub.loop) {
      // Kick the loop off once (its instructions), then walk the items one at a time.
      const loopId = `${section.key}:${sub.key}`;
      if (!injected.has(loopId)) return { id: loopId, prompt: sub.prompt };
      const next = (state.loops[sub.key] ?? []).find((it) => !it.done);
      if (next) {
        const itemId = `${loopId}:${next.id}`;
        return injected.has(itemId) ? null : { id: itemId, prompt: `Next: ${next.label}` };
      }
      continue; // loop kicked off, every item done (or none yet) → move to the next substep
    }
    // Static substep: inject once, then wait until it's marked done.
    if (!state.doneSubsteps.has(sub.key)) {
      const id = `${section.key}:${sub.key}`;
      return injected.has(id) ? null : { id, prompt: sub.prompt };
    }
  }
  return null;
}

/**
 * Collapse a (possibly multi-line, bulleted) step prompt to a SINGLE line for the CLI input.
 * Claude's input bar doesn't submit a multi-line paste on a lone Enter — but single-line text +
 * `\r` does (the path the pitch/reply already use). Flattening makes the inject actually send
 * instead of just sitting pasted. Bullets/newlines become inline spaces.
 */
export function flattenPrompt(prompt: string): string {
  return prompt.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
}

export interface DeliverySignals {
  /** Output grew since the inject — the universal "planner engaged" fallback. */
  outputGrew: boolean;
  /** Section file stems that now have content (e.g. "goal", "stack"). */
  sectionKeys: Set<string>;
  /** Feature slugs the planner has begun defining (behavior/acceptance present). */
  startedFeatures: Set<string>;
  /** Whether features.json has any entries yet (for the "propose" step). */
  featuresExist: boolean;
}

/**
 * Whether an injected step has been DELIVERED — the planner acted on it (so we stop re-injecting).
 * Uses the strongest signal available for the step (its artifact appeared), and falls back to
 * `outputGrew` (the planner responded at all) for steps with no measurable artifact: the stage
 * orientation prompts (`:_stage`), informational stages, and the open-ended dimensions loop.
 * Note: delivered ≠ done — a step can land and still be in-progress; advancement is governed
 * separately by the gate / confirmation in {@link nextInjection}.
 */
export function isStepDelivered(stepId: string, s: DeliverySignals): boolean {
  const [stage, sub, item] = stepId.split(":");
  if (sub && sub !== "_stage" && !item) {
    if (s.sectionKeys.has(sub)) return true;                 // a discovery substep's file appeared
    if (sub === "propose" && s.featuresExist) return true;   // the feature list exists
  } else if (stage === "features" && sub === "features" && item) {
    if (s.startedFeatures.has(item)) return true;            // this feature began being defined
  }
  return s.outputGrew;                                       // universal fallback
}
