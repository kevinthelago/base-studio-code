// Barrel for the Skills feature's pure helpers — the SkillDef model, per-session
// resolution, catalog → definition templates, the planner `skills.json` parser,
// and the conversion to the backend payload written into a session's
// `.claude/skills/<slug>/SKILL.md`.
//
// Free of React / Tauri imports so it can be unit-tested and shared between the
// store, the Skills screen, the planner ingestion, and TerminalView. Mirrors
// lib/mcpServers.ts. Decomposed into colocated modules (#2151); this barrel keeps
// the original public API intact so every importer works unchanged.

export { type SkillDef, skillSlug, blankSkill } from "./skillsModel";
export { skillFromPayload, seedSkills, refreshPackagedSkills } from "./skillsSeed";
export {
  resolveSkills, sessionSkillState, effectiveSessionSkills, applySessionSkillChoice,
  type SessionSkillOverride, type SessionSkillReason, type SessionSkillState,
} from "./skillsSession";
export {
  expandGroups, groupSkillCount, parseSkillGroupsFile, type SkillGroup,
} from "./skillGroups";
export { toSkillCfgs, type SkillCfg } from "./skillsPayload";
export { parseSkillsFile, type PlannerSkill } from "./skillsParser";
export { deriveSkillKpis, type DerivedSkillKpis } from "./skillsKpis";
