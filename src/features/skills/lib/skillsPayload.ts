// Backend payload: resolved SkillDefs → the SkillCfg shape handed to
// `ensure_session_settings` and written into a session's `.claude/skills/<slug>/SKILL.md`.

import { skillSlug, type SkillDef } from "./skillsModel";

// ── Backend payload ─────────────────────────────────────────────────────────
// Shape handed to `ensure_session_settings` (field names match the Rust SkillCfg).

export interface SkillCfg {
  /** Stable skilldb id — carried so the backend can count an attach as a use (#A). */
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
}

/** Resolved skills → their `.claude/skills/<slug>/SKILL.md` payloads. Skips any
 *  skill whose name slugs to empty (nothing to key the directory on). Carries the
 *  stable id so the launch path can count an attach as a use (#A). */
export function toSkillCfgs(defs: SkillDef[]): SkillCfg[] {
  const out: SkillCfg[] = [];
  for (const s of defs) {
    if (!skillSlug(s.name)) continue;
    out.push({ id: s.id, name: s.name, description: s.desc, prompt: s.prompt, tools: s.tools });
  }
  return out;
}
