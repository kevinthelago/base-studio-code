// The SkillDef model + the leaf helpers every other skills-lib module builds on:
// the directory-safe slug and the blank-form factory, plus the coercion key sets
// derived from the shared skills data.
//
// Free of React / Tauri imports so it can be unit-tested and shared between the
// store, the Skills screen, the planner ingestion, and TerminalView.

import {
  KIND, PROFILE_COLOR,
  type SkillKind, type SkillSource, type SkillProfile,
} from "@/shared/data/skills";

export const KIND_KEYS = Object.keys(KIND) as SkillKind[];
export const PROFILE_KEYS = Object.keys(PROFILE_COLOR) as SkillProfile[];
export const SOURCE_KEYS: SkillSource[] = ["first-party", "team", "imported", "community"];

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

/** Directory-safe slug for a skill name (matches the Rust slugger). */
export function skillSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
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
