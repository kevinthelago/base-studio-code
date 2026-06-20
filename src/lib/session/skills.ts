// Pure helpers for the Skills feature — the SkillDef model, per-session
// resolution, catalog → definition templates, the planner `skills.json` parser,
// and the conversion to the backend payload written into a session's
// `.claude/skills/<slug>/SKILL.md`.
//
// Free of React / Tauri imports so it can be unit-tested and shared between the
// store, the Skills screen, the planner ingestion, and TerminalView. Mirrors
// lib/mcpServers.ts.

import {
  SKILLS, SKILL_CATALOG, KIND, PROFILE_COLOR,
  type Skill, type SkillKind, type SkillSource, type SkillProfile,
} from "../../data/skills";

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
  /** Code-owned packaged skill (seeded from {@link seedSkills}). Lets a load-time
   *  refresh replace it from code and prune any packaged skill dropped from the
   *  library, while never touching user-created / imported / catalog skills. */
  packaged?: boolean;
  // ── display-only telemetry (not yet live; see #404 follow-up) ──
  invocations: number;
  success: number;
  avgTokensK: number;
  trend: number[];
}

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
  // A packaged skill (re-)added from the catalog restores its full def — body,
  // tools, kind, profiles — not just the one-line description.
  const packaged = SKILLS.find(s => s.name === name);
  if (packaged) {
    const { id: _id, ...rest } = fromSample(packaged);
    return { ...rest, enabled: false };
  }
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
