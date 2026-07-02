// Task groups (#skills-groups): named, reusable bundles of skills toggled as one,
// their expansion into a member-id set, membership counting, and the planner's
// `skill_groups.json` parser.

import { skillSlug, type SkillDef } from "./skillsModel";

// ── Task groups (#skills-groups) ────────────────────────────────────────────────
// A "task group" is a named, reusable bundle of skills (the redesign's ⬡). Many-to-many with
// skills (a skill can belong to several groups), keyed by stable skill id. A group is the unit of
// bulk toggling: toggle a group onto a session (manually, Workspace B) or onto a fleet stream (the
// planner) and every member skill is enabled at once. Groups are LIVE references — editing a
// group's membership updates every session/stream that has it on, rather than freezing the set.

/** A named bundle of skills, toggled as one. */
export interface SkillGroup {
  id: string;
  name: string;
  /** Accent hue (a `--token` ref or oklch literal) for the group's ⬡ chip/tile. */
  hue: string;
  /** Member skill ids (stable — never names, which can change). */
  skillIds: string[];
}

/** The DISTINCT member skill ids across a set of enabled group ids (order-stable, de-duped). An
 *  unknown group id contributes nothing. Used to expand a session's/stream's toggled-on groups
 *  into the `groupSkillIds` set that {@link effectiveSessionSkills} folds in. */
export function expandGroups(groupIds: readonly string[], groups: SkillGroup[]): string[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out = new Set<string>();
  for (const gid of groupIds) for (const sid of byId.get(gid)?.skillIds ?? []) out.add(sid);
  return [...out];
}

/** Membership count of a group whose member skills still exist in `all` (the chip count). */
export function groupSkillCount(group: SkillGroup, all: SkillDef[]): number {
  const ids = new Set(all.map((s) => s.id));
  return group.skillIds.filter((id) => ids.has(id)).length;
}

/** Parse the planner's `skill_groups.json` (a JSON array of `{name, hue?, skills?: string[]}`) into
 *  clean groups. `skills` may be skill ids OR name-slugs (the planner authors by name); they're
 *  resolved against the library here so the stored group keys by id. Tolerant: malformed input →
 *  []; a row without a usable name is dropped. Mirrors {@link parseSkillsFile}. */
export function parseSkillGroupsFile(raw: string, all: SkillDef[]): Array<Omit<SkillGroup, "id"> & { id?: string }> {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const bySlug = new Map(all.map((s) => [skillSlug(s.name), s.id]));
  const byId = new Set(all.map((s) => s.id));
  const out: Array<Omit<SkillGroup, "id"> & { id?: string }> = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) continue;
    const refs = Array.isArray(r.skills) ? r.skills.filter((x): x is string => typeof x === "string") : [];
    const skillIds = Array.from(new Set(
      refs.map((ref) => (byId.has(ref) ? ref : bySlug.get(skillSlug(ref)))).filter((x): x is string => !!x),
    ));
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : undefined,
      name,
      hue: typeof r.hue === "string" && r.hue ? r.hue : "var(--accent)",
      skillIds,
    });
  }
  return out;
}
