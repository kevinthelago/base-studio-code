// Planner introduction kickoff selection (#1240). Pure helpers so mode selection + pitch
// composition are unit-testable; the Rust `planner_intro_prompt` command returns the per-mode
// template text, and the launch bakes the composed result as a fresh-only startup prompt.

import type { BlueprintMode } from "../stages/blueprints";

export type PlannerIntroMode = "new" | "existing" | "blueprint";

/**
 * Whether the planner should take the "existing repos" orientation — for BOTH the intro greeting
 * and the generated CLAUDE.md spec (`setup_workspaces`). True when the project is already saved OR
 * the blueprint's lifecycle is `operate` (transform / harden / maintain — work against existing
 * repos). #1286: keying off the blueprint **mode**, not just save-state, fixes an operate-mode
 * project on a fresh draft — or right after a greenfield→transform lifecycle switch — being
 * mis-oriented as a new greenfield one. (A saved greenfield project is unchanged: still "existing".)
 */
export function plannerTreatAsExisting({ isSaved, mode }: { isSaved: boolean; mode?: BlueprintMode }): boolean {
  return isSaved || mode === "operate";
}

/** Pick the intro mode from the session signals — mirrors the planner.rs CLAUDE.md branch
 *  (authoring wins, then an existing project, else a new greenfield project). */
export function plannerIntroMode({ isAuthoring, isExisting }: { isAuthoring: boolean; isExisting: boolean }): PlannerIntroMode {
  return isAuthoring ? "blueprint" : isExisting ? "existing" : "new";
}

/** Compose the startup prompt: the mode's intro, plus the user's pitch for a NEW project so the
 *  planner acknowledges it instead of asking what they're building. An empty intro (e.g. the
 *  command failed) yields `""` so the launch falls back to its plain `initCmd`. */
export function composePlannerIntro(intro: string, mode: PlannerIntroMode, pitch: string): string {
  if (!intro.trim()) return "";
  if (mode === "new" && pitch.trim()) {
    return `${intro}\n\n---\nThe user has already shared this pitch — acknowledge it and reflect your understanding back instead of asking what they're building:\n\n${pitch.trim()}`;
  }
  return intro;
}
