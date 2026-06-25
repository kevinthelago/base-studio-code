// The frontend ↔ global skills.db bridge (#1338 ph2). The desktop Skills library and every live
// console session share ONE global store (`~/.base-studio-code/skills.db`), reached here through the
// `skill_store_*` Tauri commands (thin wrappers over the `skilldb` crate) and, from a session's own
// shell, through the `bsc-skill` CLI. This is the only place the skills feature touches Tauri, so the
// pure model in `skills.ts` stays React/Tauri-free.
//
// Source-of-truth: skills.db. The Zustand slice is a write-through cache — `loadLibrary` hydrates it
// on boot; each library mutation pushes through here. Per-session toggles (overrides / toggled-on
// groups) are NOT part of the global library and stay store-local; only skills + groups round-trip.
//
// Mapping: the Rust `Skill` omits the display-only telemetry (`invocations`/`success`/`avgTokensK`/
// `trend`), so a loaded skill is re-defaulted to a full {@link SkillDef} here; pushing a SkillDef is
// serde-safe because the Rust side ignores the extra telemetry fields.

import { invoke } from "@tauri-apps/api/core";
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
  try {
    const [skills, groups] = await Promise.all([
      invoke<Array<Partial<SkillDef> & { id: string; name: string }>>("skill_store_list"),
      invoke<SkillGroup[]>("skill_group_list"),
    ]);
    return { skills: (skills ?? []).map(toDef), groups: groups ?? [] };
  } catch {
    return null;
  }
}

/** Write-through a skill upsert. Fire-and-forget at the call site; never throws. */
export async function pushSkill(skill: SkillDef): Promise<void> {
  try { await invoke("skill_store_upsert", { skill }); } catch { /* bridge absent — cache-only */ }
}

/** Write-through a skill removal. */
export async function dropSkill(id: string): Promise<void> {
  try { await invoke("skill_store_remove", { id }); } catch { /* bridge absent */ }
}

/** Write-through a group upsert. */
export async function pushGroup(group: SkillGroup): Promise<void> {
  try { await invoke("skill_group_upsert", { group }); } catch { /* bridge absent */ }
}

/** Write-through a group removal. */
export async function dropGroup(id: string): Promise<void> {
  try { await invoke("skill_group_remove", { id }); } catch { /* bridge absent */ }
}
