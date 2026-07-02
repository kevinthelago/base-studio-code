// The frontend ↔ global skills.db bridge (#1338 ph2). The desktop Skills library and every live
// console session share ONE global store (`~/.base-studio-code/skills.db`), reached here — and from a
// session's own shell — through the SAME `bsc skill …` CLI, over the generic `bsc` bridge (#2114/#2142;
// it replaced the parallel per-verb `skill_store_*`/`skill_group_*` Tauri commands). Skills are GLOBAL
// (no project key) so every call passes `null` as the bridge's `projectKey`. This is the only place the
// skills feature touches Tauri, so the pure model in `skills.ts` stays React/Tauri-free.
//
// Source-of-truth: skills.db. The Zustand slice is a write-through cache — `loadLibrary` hydrates it
// on boot; each library mutation pushes through here. Per-session toggles (overrides / toggled-on
// groups) are NOT part of the global library and stay store-local; only skills + groups round-trip.
//
// Mapping: the Rust `Skill` omits the display-only telemetry (`invocations`/`success`/`avgTokensK`/
// `trend`), so a loaded skill is re-defaulted to a full {@link SkillDef} here; pushing a SkillDef is
// serde-safe because the Rust side ignores the extra telemetry fields. `list --full` (#2142) emits the
// COMPLETE skill objects (prompt + tools/profiles/packaged), matching the old `skill_store_list` shape
// — the lean paginated `list` would drop the `prompt` body that a write-through would then blank.

import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import type { SkillDef, SkillGroup } from "./skills";
import type { SkillKind, SkillSource, SkillProfile } from "@/shared/data/skills";

/** The library as stored in skills.db (telemetry re-defaulted to zero on the way in). */
export interface Library {
  skills: SkillDef[];
  groups: SkillGroup[];
}

/** A skill row from the bridge → a full {@link SkillDef} (zero telemetry; packaged defaults false). */
function toDef(s: Partial<SkillDef> & { id: string; name: string }): SkillDef {
  return {
    id: s.id,
    name: s.name,
    kind: (s.kind as SkillKind) ?? "workflow",
    source: (s.source as SkillSource) ?? "first-party",
    desc: s.desc ?? "",
    prompt: s.prompt ?? "",
    tools: s.tools ?? [],
    profiles: (s.profiles as SkillProfile[]) ?? [],
    projects: s.projects ?? [],
    enabled: !!s.enabled,
    pinned: !!s.pinned,
    packaged: !!s.packaged,
    invocations: 0, success: 0, avgTokensK: 0, trend: [],
  };
}

/**
 * Hydrate the library from skills.db. Returns `null` when the bridge is unreachable (no Tauri host —
 * tests, the web shell, or an old binary), so the caller keeps its seeded in-memory set rather than
 * blanking the UI. Any single bad row is tolerated (the command itself either succeeds with the full
 * set or rejects).
 */
export async function loadLibrary(): Promise<Library | null> {
  // NOT `bscJson` here: its graceful degrade-to-fallback would return an EMPTY library when the bridge
  // is unreachable, and hydrate would then blank the seeded set. We need the explicit `null` (keep the
  // seeded set) the store depends on — so raw `bsc` + catch, exactly like the old per-command version.
  try {
    const [skillsOut, groupsOut] = await Promise.all([
      bsc(null, ["skill", "list", "--full"]), // full-fidelity array (incl. prompt) — the #2142 read
      bsc(null, ["skill", "group", "list"]),
    ]);
    const skills = JSON.parse(skillsOut.trim() || "[]") as Array<Partial<SkillDef> & { id: string; name: string }>;
    const groups = JSON.parse(groupsOut.trim() || "[]") as SkillGroup[];
    return { skills: (skills ?? []).map(toDef), groups: groups ?? [] };
  } catch {
    return null;
  }
}

/** Write-through a skill upsert (`bsc skill add` reads the JSON on stdin). Fire-and-forget; never throws. */
export async function pushSkill(skill: SkillDef): Promise<void> {
  await bscWrite(null, ["skill", "add"], skill);
}

/** Write-through a skill removal (`bsc skill remove <id>`). */
export async function dropSkill(id: string): Promise<void> {
  await bscRun(null, ["skill", "remove", id]);
}

/** Write-through a group upsert (`bsc skill group add` reads the JSON on stdin). */
export async function pushGroup(group: SkillGroup): Promise<void> {
  await bscWrite(null, ["skill", "group", "add"], group);
}

/** Write-through a group removal (`bsc skill group remove <id>`). */
export async function dropGroup(id: string): Promise<void> {
  await bscRun(null, ["skill", "group", "remove", id]);
}
