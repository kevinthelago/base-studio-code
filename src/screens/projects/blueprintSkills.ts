// Blueprint skills/knowledge attachment (#636 slice a). A blueprint section (and the
// blueprint as a whole) can reference reusable library items — Knowledge Blocks or
// Skills — that slice b injects into the agent's context. This unifies the two libraries
// into one pickable list and resolves attached ids (so the editor can show what's
// attached + warn about anything missing). Pure.

import { type SkillDef } from "../../lib/skills";
import { type KbBlock } from "../../data/mock";

/** One pickable library item, from either library. */
export interface BlueprintSkillItem {
  id: string;
  name: string;
  kind: "skill" | "kb";
  desc?: string;
}

/** Unify the Skills library + Knowledge Blocks into one list for the editor's picker. */
export function buildSkillLibrary(skills: SkillDef[], kb: KbBlock[]): BlueprintSkillItem[] {
  return [
    ...skills.map((s): BlueprintSkillItem => ({ id: s.id, name: s.name, kind: "skill", desc: s.desc })),
    ...kb.map((b): BlueprintSkillItem => ({ id: b.id, name: b.title, kind: "kb", desc: b.tags.join(", ") || undefined })),
  ];
}

export interface ResolvedSkills { found: BlueprintSkillItem[]; missing: string[] }

/** Resolve attached ids against the library: `found` for display, `missing` to warn
 *  (a referenced item that isn't installed — the distribution gap). Order preserved. */
export function resolveBlueprintSkills(ids: string[], library: BlueprintSkillItem[]): ResolvedSkills {
  const byId = new Map(library.map((i) => [i.id, i]));
  const found: BlueprintSkillItem[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) found.push(item);
    else missing.push(id);
  }
  return { found, missing };
}
