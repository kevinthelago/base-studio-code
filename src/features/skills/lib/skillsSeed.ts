// Catalog → SkillDef templates and the packaged-skill lifecycle: seeding the
// initial library from the sample set, reconstructing a def from a shared
// blueprint's embedded payload, and reconciling a persisted library with the
// code-owned packaged set on load.

import { SKILLS, type Skill, type SkillKind } from "@/shared/data/skills";
import { KIND_KEYS, type SkillDef } from "./skillsModel";

/** Reconstruct a SkillDef from a shared blueprint's embedded skill payload (#897 Phase 5b).
 *  Keeps the original id (so the blueprint's refs resolve) + content; marks it `source:
 *  "imported"` and defaults everything else (kind falls back to the first known kind when the
 *  payload didn't carry one). Structural param so there's no import cycle with blueprintSkills. */
export function skillFromPayload(p: { id: string; name: string; content: string; desc?: string; skillKind?: SkillKind; tools?: string[] }): SkillDef {
  return {
    id: p.id,
    name: p.name,
    kind: p.skillKind && KIND_KEYS.includes(p.skillKind) ? p.skillKind : KIND_KEYS[0],
    source: "imported",
    desc: p.desc ?? "",
    prompt: p.content,
    tools: p.tools ?? [],
    profiles: [],
    projects: [],
    enabled: true,
    pinned: false,
    invocations: 0, success: 0, avgTokensK: 0, trend: [],
  };
}

/** A sample {@link Skill} → a full editable {@link SkillDef} (enabled + global).
 *  Telemetry (invocations/success/trend/avgTokensK) starts at zero — real usage
 *  is supplied later from the skill-usage log (#406), never seeded with samples. */
function fromSample(s: Skill): SkillDef {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    source: s.source,
    desc: s.desc,
    // Packaged skills carry a full authored procedure in `body`; fall back to the
    // description for any skill that doesn't (the user/planner can refine it).
    prompt: s.body ?? s.desc,
    tools: [...s.tools],
    profiles: [...s.profiles],
    projects: [],
    enabled: true,
    pinned: !!s.pinned,
    packaged: true,
    invocations: 0,
    success: 0,
    avgTokensK: 0,
    trend: [],
  };
}

/** The initial skills library — the sample set, made editable. */
export function seedSkills(): SkillDef[] {
  return SKILLS.map(fromSample);
}

/** Packaged skill ids retired before the {@link SkillDef.packaged} marker existed.
 *  An already-seeded store persisted these as plain skills with no way to tell they
 *  were code-owned — list them here so {@link refreshPackagedSkills} prunes them.
 *  (Going forward, removing a packaged skill needs no entry: the `packaged` flag
 *  prunes it automatically.) */
const RETIRED_PACKAGED_SKILL_IDS = new Set([
  "scaffold-tauri-cmd", "add-screen-slice", "open-pr", "triage-failing-test",
  "bump-dep-safely", "wire-mcp-tool", "security-review", "api-docs", "rename-symbol",
]);

/**
 * Reconcile a persisted skills library with the code-owned packaged set on load
 * (mirrors blueprints' `refreshBuiltIns`, #677). The packaged skills are code-owned
 * but `skills` is persisted, so a store seeded before the library changed would keep
 * the old set forever. This:
 *   • refreshes each current packaged skill from code (preserving the user's
 *     enabled / pinned / project-scoping toggles),
 *   • prunes packaged skills dropped from the library (by the `packaged` flag or the
 *     retired-id list), and
 *   • leaves user-created / imported / catalog-added skills untouched.
 */
export function refreshPackagedSkills(persisted: SkillDef[]): SkillDef[] {
  const fresh = seedSkills();
  const seedIds = new Set(fresh.map((s) => s.id));
  const packaged = fresh.map((f) => {
    const prev = persisted.find((s) => s.id === f.id);
    return prev ? { ...f, enabled: prev.enabled, pinned: prev.pinned, projects: prev.projects } : f;
  });
  const user = persisted.filter(
    (s) => !seedIds.has(s.id) && !s.packaged && !RETIRED_PACKAGED_SKILL_IDS.has(s.id),
  );
  return [...packaged, ...user];
}
