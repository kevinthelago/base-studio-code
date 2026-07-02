// Per-session skill resolution: which library skills apply to a project, and the
// per-session override layer (#1056 follow-up) — force a skill ON/OFF for one
// session over its inherited project resolution, with the reason label the UI shows.

import type { SkillDef } from "./skillsModel";

/**
 * The enabled skills that apply to a session in `projectId`: a def applies when it
 * is enabled AND either global (`projects` empty) or scoped to this project. An
 * empty `projectId` (no project) yields only global defs.
 */
export function resolveSkills(all: SkillDef[], projectId: string): SkillDef[] {
  return all.filter(
    s => s.enabled && (s.projects.length === 0 || (!!projectId && s.projects.includes(projectId))),
  );
}

// ── Per-session assignment (#1056 follow-up) ────────────────────────────────────
// A session (a console pane, a fleet worker, a triage pane) INHERITS the skills that
// resolve for its project (enabled + global/project-scoped — see resolveSkills). On top
// of that the user can choose, per session, to force a skill ON (even one out of the
// session's project scope) or OFF (one it would otherwise inherit). The choice is keyed by
// the session's STABLE identity id so it survives a relaunch. The Skills UI (per-session
// surface) renders sessionSkillState per row; the launch path writes effectiveSessionSkills
// into the session's `.claude/skills/<slug>/SKILL.md`.

/** A user's per-session skill choices, layered over the inherited resolution. Both are
 *  skill ids; a skill in neither list inherits its project-resolved state. */
export interface SessionSkillOverride {
  /** Force ON for this session (incl. an enabled skill outside the session's project scope). */
  add: string[];
  /** Force OFF for this session (a skill it would otherwise inherit). */
  remove: string[];
}

/** Why a skill is on/off for a session — drives the per-session row label. */
export type SessionSkillReason =
  | "global"        // on: enabled + global (applies to every project)
  | "project"       // on: enabled + scoped to this session's project
  | "pinned"        // on (inherited) + pinned (auto-available to the fleet)
  | "group"         // on: enabled via a task group toggled onto this session/stream
  | "added"         // on: a user override turned it on for this session
  | "removed"       // off: a user override turned it off for this session
  | "out-of-scope"  // off: enabled but scoped to other projects (and not added)
  | "disabled";     // off: disabled in the library (never written to any session)

export interface SessionSkillState {
  skill: SkillDef;
  /** Whether this skill is written into the session (its `.claude/skills/<slug>`). */
  on: boolean;
  reason: SessionSkillReason;
  /** True when the effective state DIFFERS from what the session would inherit — i.e. a
   *  live user override (added / removed). */
  overridden: boolean;
}

/**
 * The effective on/off state + reason for one skill in one session, given the override and the
 * skills enabled via the session's task groups (`groupSkillIds`). `disabled` wins over everything
 * (a disabled skill is never invocable). The baseline is "inherited by project scope OR enabled by
 * a toggled-on group"; a remove/add per-skill override beats that baseline. An override that matches
 * the baseline is a no-op (`overridden: false`) so the UI never flags a redundant choice.
 */
export function sessionSkillState(
  skill: SkillDef, projectId: string, override?: SessionSkillOverride, groupSkillIds?: ReadonlySet<string>,
): SessionSkillState {
  if (!skill.enabled) return { skill, on: false, reason: "disabled", overridden: false };
  const inScope = skill.projects.length === 0 || (!!projectId && skill.projects.includes(projectId));
  const viaGroup = groupSkillIds?.has(skill.id) ?? false;
  const baseOn = inScope || viaGroup;            // `enabled` already guaranteed above
  const removed = override?.remove?.includes(skill.id) ?? false;
  const added = override?.add?.includes(skill.id) ?? false;
  const on = removed ? false : added ? true : baseOn;
  const overridden = on !== baseOn;
  let reason: SessionSkillReason;
  if (overridden) reason = on ? "added" : "removed";
  else if (on) reason = inScope ? (skill.pinned ? "pinned" : skill.projects.length === 0 ? "global" : "project") : "group";
  else reason = "out-of-scope";
  return { skill, on, reason, overridden };
}

/** The skills written into a session: every library skill whose {@link sessionSkillState} is `on`
 *  for this project + override + toggled-on groups. With no override/groups this equals
 *  {@link resolveSkills}. */
export function effectiveSessionSkills(
  all: SkillDef[], projectId: string, override?: SessionSkillOverride, groupSkillIds?: ReadonlySet<string>,
): SkillDef[] {
  return all.filter(s => sessionSkillState(s, projectId, override, groupSkillIds).on);
}

/** Layer a user choice onto a session's override (pure). "on" forces the skill on, "off"
 *  forces it off, "inherit" clears any override for it. Returns a fresh override; the caller
 *  drops it from the map when both lists are empty (back to pure inheritance). */
export function applySessionSkillChoice(
  override: SessionSkillOverride | undefined, skillId: string, choice: "on" | "off" | "inherit",
): SessionSkillOverride {
  const add = new Set(override?.add ?? []);
  const remove = new Set(override?.remove ?? []);
  add.delete(skillId);
  remove.delete(skillId);
  if (choice === "on") add.add(skillId);
  else if (choice === "off") remove.add(skillId);
  return { add: [...add], remove: [...remove] };
}
