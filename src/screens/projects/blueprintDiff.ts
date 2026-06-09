// Section-level diff between two blueprints (#598 follow-up) — drives the Sync modal's
// upstream-change list. Compares by section key: a key only upstream is an add, only
// local is a delete, in both with different prompt/pipelines/output is a change. Pure.

import { type Blueprint, type BlueprintSection } from "./blueprints";

export interface DiffLine { type: "add" | "mod" | "del"; title: string; note: string }

/** A stable signature of a section's meaningful content (ignores uids/order of pipes). */
function sig(s: BlueprintSection): string {
  const pipes = s.pipelines.map((p) => `${p.id}:${p.trigger}:${p.gate ? "g" : ""}:${p.enabled ? "1" : "0"}`).sort().join(",");
  return JSON.stringify({ prompt: s.prompt, output: s.output ?? "", deps: [...s.deps].sort(), pipes, name: s.name });
}

/** Diff `local` against `upstream` (what pulling upstream would change). */
export function diffBlueprints(local: Blueprint, upstream: Blueprint): DiffLine[] {
  const lByKey = new Map(local.sections.map((s) => [s.key, s]));
  const uByKey = new Map(upstream.sections.map((s) => [s.key, s]));
  const out: DiffLine[] = [];
  for (const u of upstream.sections) {
    const l = lByKey.get(u.key);
    if (!l) out.push({ type: "add", title: u.name, note: "new stage upstream" });
    else if (sig(l) !== sig(u)) out.push({ type: "mod", title: u.name, note: "changed upstream" });
  }
  for (const l of local.sections) {
    if (!uByKey.has(l.key)) out.push({ type: "del", title: l.name, note: "removed upstream" });
  }
  return out;
}
