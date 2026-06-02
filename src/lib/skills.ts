// Pure helpers for the Skills feature — the SkillDef model, per-session
// resolution, catalog → definition templates, the planner `skills.json` parser,
// and the conversion to the backend payload written into a session's
// `.claude/skills/<slug>/SKILL.md`.
//
// Free of React / Tauri imports so it can be unit-tested and shared between the
// store, the Skills screen, the planner ingestion, and TerminalView. Mirrors
// lib/extensions.ts.

import {
  SKILLS, SKILL_CATALOG, KIND, PROFILE_COLOR,
  type Skill, type SkillKind, type SkillSource, type SkillProfile,
} from "../data/skills";

const KIND_KEYS = Object.keys(KIND) as SkillKind[];
const PROFILE_KEYS = Object.keys(PROFILE_COLOR) as SkillProfile[];
const SOURCE_KEYS: SkillSource[] = ["first-party", "team", "imported", "community"];

/**
 * A user- or planner-configured skill: a reusable capability bundle (a prompt +
 * bundled tools + profile guardrails) any worker may invoke. Injected into a
 * launched session as a Claude Code Skill file. Scoped via {@link SkillDef.projects}.
 */
export interface SkillDef {
  id: string;
  name: string;
  kind: SkillKind;
  source: SkillSource;
  /** One-line description (the SKILL.md frontmatter `description` + the card). */
  desc: string;
  /** The reusable procedure, written as the SKILL.md body. */
  prompt: string;
  /** Tool names bundled with the skill → the SKILL.md `allowed-tools`. */
  tools: string[];
  /** Permission profiles allowed to invoke it. */
  profiles: SkillProfile[];
  /** `[]` = every project (global); otherwise the project ids it applies to. */
  projects: string[];
  enabled: boolean;
  /** Pinned skills are auto-available to the fleet. */
  pinned: boolean;
  // ── display-only telemetry (not yet live; see #404 follow-up) ──
  invocations: number;
  success: number;
  avgTokensK: number;
  trend: number[];
}

/** A sample {@link Skill} → a full editable {@link SkillDef} (enabled + global). */
function fromSample(s: Skill): SkillDef {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    source: s.source,
    desc: s.desc,
    // The sample library has no authored body; the description is a sane default
    // the user/planner can refine. Real skills carry a full procedure.
    prompt: s.desc,
    tools: [...s.tools],
    profiles: [...s.profiles],
    projects: [],
    enabled: true,
    pinned: !!s.pinned,
    invocations: s.invocations,
    success: s.success,
    avgTokensK: s.avgTokensK,
    trend: [...s.trend],
  };
}

/** The initial skills library — the sample set, made editable. */
export function seedSkills(): SkillDef[] {
  return SKILLS.map(fromSample);
}

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

// ── Backend payload ─────────────────────────────────────────────────────────
// Shape handed to `ensure_session_settings` (field names match the Rust SkillCfg).

export interface SkillCfg {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
}

/** Resolved skills → their `.claude/skills/<slug>/SKILL.md` payloads. Skips any
 *  skill whose name slugs to empty (nothing to key the directory on). */
export function toSkillCfgs(defs: SkillDef[]): SkillCfg[] {
  const out: SkillCfg[] = [];
  for (const s of defs) {
    if (!skillSlug(s.name)) continue;
    out.push({ name: s.name, description: s.desc, prompt: s.prompt, tools: s.tools });
  }
  return out;
}

/** Directory-safe slug for a skill name (matches the Rust slugger). */
export function skillSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

// ── Catalog templates ─────────────────────────────────────────────────────────

/** A ready-to-add SkillDef (minus id) for a catalog entry — disabled + global by
 *  default; the caller assigns the id and the user fills the prompt/tools. */
export function defFromCatalog(name: string): Omit<SkillDef, "id"> {
  const c = SKILL_CATALOG.find(x => x.name === name);
  const kind = c ? kindForGlyph(c.glyph) : "workflow";
  return {
    name,
    kind,
    source: c?.by === "first-party" ? "first-party" : c?.by === "team" ? "team" : "community",
    desc: c?.desc ?? "",
    prompt: c?.desc ?? "",
    tools: [],
    profiles: ["build"],
    projects: [],
    enabled: false,
    pinned: false,
    invocations: 0, success: 0, avgTokensK: 0, trend: [],
  };
}

/** Map a catalog glyph back to a kind (the catalog reuses the KIND glyphs). */
function kindForGlyph(glyph: string): SkillKind {
  const hit = KIND_KEYS.find(k => KIND[k].glyph === glyph);
  return hit ?? "workflow";
}

/** A blank custom skill, ready for the new-skill form. */
export function blankSkill(): Omit<SkillDef, "id"> {
  return {
    name: "", kind: "workflow", source: "first-party",
    desc: "", prompt: "", tools: [], profiles: ["build"], projects: [],
    enabled: false, pinned: false,
    invocations: 0, success: 0, avgTokensK: 0, trend: [],
  };
}

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

// ── derived KPIs (from the live list) ──────────────────────────────────────────

export interface DerivedSkillKpis {
  total: number;
  pinned: number;
  /** sum of per-skill invocations (display telemetry). */
  invWeek: number;
  /** invocation-weighted success rate (0 when there are no invocations). */
  avgSuccess: number;
}

export function deriveSkillKpis(skills: SkillDef[]): DerivedSkillKpis {
  const totalInv = skills.reduce((a, s) => a + s.invocations, 0);
  const avgSuccess = totalInv > 0
    ? Math.round(skills.reduce((a, s) => a + s.success * s.invocations, 0) / totalInv)
    : 0;
  return {
    total: skills.length,
    pinned: skills.filter(s => s.pinned).length,
    invWeek: totalInv,
    avgSuccess,
  };
}
