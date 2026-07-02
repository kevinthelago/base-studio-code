// Planner channel (skills.json): the PlannerSkill entry shape and the tolerant
// parser that turns the planner's authored JSON array into clean, defaulted skills
// the caller upserts into the global library.

import { type SkillKind, type SkillSource, type SkillProfile } from "@/shared/data/skills";
import { KIND_KEYS, PROFILE_KEYS, SOURCE_KEYS, type SkillDef } from "./skillsModel";

// ── Planner channel (skills.json) ──────────────────────────────────────────────

/** One entry the planner may write to `skills.json` (everything but id optional). */
export interface PlannerSkill extends Omit<SkillDef, "id"> { id?: string }

/**
 * Parse the planner's `skills.json` (a JSON array of skill objects) into clean,
 * defaulted {@link PlannerSkill}s. Tolerant of partial objects and malformed
 * input — anything unparseable yields `[]`, and a row without a usable name is
 * dropped. New planner skills are enabled + pinned by default (auto-available to
 * the fleet); the caller upserts them into the global library.
 */
export function parseSkillsFile(raw: string): PlannerSkill[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out: PlannerSkill[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) continue;
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : undefined,
      name,
      kind: coerceKind(r.kind),
      source: coerceSource(r.source) ?? "team",
      desc: typeof r.desc === "string" ? r.desc : typeof r.description === "string" ? r.description : "",
      prompt: typeof r.prompt === "string" ? r.prompt : "",
      tools: coerceStrings(r.tools),
      profiles: coerceProfiles(r.profiles),
      projects: coerceStrings(r.projects),
      enabled: r.enabled === undefined ? true : !!r.enabled,
      pinned: r.pinned === undefined ? true : !!r.pinned,
      invocations: 0, success: 0, avgTokensK: 0, trend: [],
    });
  }
  return out;
}

function coerceStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}
function coerceKind(v: unknown): SkillKind {
  return typeof v === "string" && (KIND_KEYS as string[]).includes(v) ? v as SkillKind : "workflow";
}
function coerceSource(v: unknown): SkillSource | null {
  return typeof v === "string" && (SOURCE_KEYS as string[]).includes(v) ? v as SkillSource : null;
}
function coerceProfiles(v: unknown): SkillProfile[] {
  const arr = coerceStrings(v).filter(x => (PROFILE_KEYS as string[]).includes(x)) as SkillProfile[];
  return arr.length ? arr : ["build"];
}
