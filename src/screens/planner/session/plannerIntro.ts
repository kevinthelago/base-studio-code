// Planner introduction kickoff selection (#1240). Pure helpers so mode selection + pitch
// composition are unit-testable; the Rust `planner_intro_prompt` command returns the per-mode
// template text, and the launch bakes the composed result as a fresh-only startup prompt.

export type PlannerIntroMode = "new" | "existing" | "blueprint";

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
