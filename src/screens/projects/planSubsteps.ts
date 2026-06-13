// Substep + pipeline-trigger resolution (#…). Pure helpers over the blueprint section model:
// which substep the conductor injects next, and which pipelines fire for a given event. The
// conductor (Planning.tsx) and the trigger-options editor (BlueprintEditor.tsx) both read these.
// No React/Tauri — fully unit-testable.
import type { BlueprintSection, Pipeline, PipelineTrigger, SubStep } from "./blueprints";

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

/** Pipelines that should fire for a (trigger, artifactKey) event. A pipeline with no
 *  `triggerTarget` (or "*") is whole-stage scoped; a targeted one fires only when artifactKey
 *  matches its target (a substep key or loop id). Disabled pipelines never fire. */
export function pipelinesFor(
  section: Pick<BlueprintSection, "pipelines">,
  trigger: PipelineTrigger,
  artifactKey?: string,
): Pipeline[] {
  return section.pipelines.filter(
    (p) =>
      p.enabled &&
      p.trigger === trigger &&
      (!p.triggerTarget || p.triggerTarget === "*" || p.triggerTarget === artifactKey),
  );
}

const LOOP_NOUN: Record<string, string> = { features: "feature", repos: "repo", topics: "topic" };

export interface TriggerTarget {
  value: string;
  label: string;
}

/** The scope options a pipeline's trigger can bind to within a section — the whole stage, each
 *  static substep ("After Stack"), or a loop ("For each feature"). Drives the editor dropdown so
 *  the user can fire a pipeline right after a specific file, or per feature, not only on
 *  stage enter/completion. */
export function triggerTargets(section: Pick<BlueprintSection, "substeps">): TriggerTarget[] {
  const opts: TriggerTarget[] = [{ value: "*", label: "Whole stage" }];
  for (const s of section.substeps ?? []) {
    opts.push(
      s.loop
        ? { value: s.key, label: `For each ${LOOP_NOUN[s.loop] ?? s.loop}` }
        : { value: s.key, label: `After ${s.label}` },
    );
  }
  return opts;
}
