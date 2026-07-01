// Pure helpers for the planner's section-by-section discovery loop.
//
// Free of React / xterm / Tauri imports so the message building can be unit-tested in isolation.
// All planner stream-tag PARSING has been removed — every planner artifact is now written via a
// `bsc plan …` command and reflected by the section poll (the tag→bsc migration, #2007–#2017).

// The `<plan_focus>` stream tag was removed (#2017): the "active topic" card-highlight it drove was
// dropped in the focused-pane redesign (#652), so it fed a discarded state value. The stepper follows
// the live session off the section files the planner writes, not a tag.

/**
 * The message injected into Claude's PTY when the user confirms a section in the
 * UI. It is the "advance to the next section" signal for the discovery loop.
 */
export function buildSectionConfirmMessage(sectionTitle: string): string {
  return `[The user confirmed the "${sectionTitle}" section in the planner UI — continue to the next section.]`;
}

/**
 * The message injected into Claude's PTY when the user deliberately SKIPS an optional stage in the
 * planner UI (#921). It tells the planner to stop any work on that stage and move on — the stage is
 * optional and the user chose not to do it.
 */
export function buildSectionSkipMessage(sectionTitle: string): string {
  return `[The user chose to SKIP the optional "${sectionTitle}" section in the planner UI — do not work on it; continue to the next section.]`;
}

// Startup scripts moved to plan.db (#2010) — the planner records per-repo kickoff/triage prompt
// docs with `bsc plan startup add`; the section poll resolves each `path` via `scriptDocRelpath`
// (below) and auto-assigns it. (The `<startup_script>` stream tag + its parser are gone.)

/**
 * Build the unified-store relpath for a script the planner wrote to its project
 * dir. `sanitizedKey` is the on-disk project folder (sanitize_project_key). A
 * path already rooted at `projects/` is returned untouched; otherwise it is
 * resolved under the project hub. Backslashes are normalized to posix and any
 * leading slashes stripped so the result satisfies read_document's path guards.
 */
export function scriptDocRelpath(sanitizedKey: string, path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.startsWith("projects/")) return clean;
  return `projects/${sanitizedKey}/${clean}`;
}
