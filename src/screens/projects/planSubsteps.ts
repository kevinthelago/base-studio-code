// Substep resolution (#…). Pure helpers over the blueprint section model: which substep the
// conductor injects next. No React/Tauri — fully unit-testable.
import type { SubStep } from "./blueprints";

/** A substep is done when: (static) its artifact key is confirmed; (loop) the conductor says
 *  the loop is finished — the model can't know per-item completion, so `loopDone` is supplied. */
export function substepDone(s: SubStep, confirmed: Set<string>, loopDone: boolean): boolean {
  return s.loop ? loopDone : confirmed.has(s.key);
}

/** The active substep = the first not-yet-done one, in order. Undefined ⇒ all substeps done
 *  (the conductor falls back to the stage's own gate). */
export function activeSubstep(
  substeps: SubStep[] | undefined,
  confirmed: Set<string>,
  loopDone = false,
): SubStep | undefined {
  return (substeps ?? []).find((s) => !substepDone(s, confirmed, loopDone));
}

