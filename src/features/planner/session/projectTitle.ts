/** The project's display title — used for the fleet/triage tab name and the published GitHub
 *  structure. Resolution order:
 *  1. an explicit planning title,
 *  2. a published project's real name (`activeProjectName`) — a named/published project should
 *     show its NAME, not a heuristic derived from its goal prose,
 *  3. the first real sentence of the goal prose, with markdown heading lines (e.g. `# Goal`)
 *     skipped so the heading never leaks as the title (was naming triage tabs "# Goal"),
 *  4. a default.
 *
 *  Single source of truth for the two call sites (`Planning.tsx` + `usePlanPublish.ts`) that used
 *  to hand-roll this and drift. */
export function deriveProjectTitle(
  planningTitle: string,
  goalContent: string,
  activeProjectName: string,
): string {
  const goalSentence = goalContent
    .replace(/^\s*#.*$/gm, "")            // drop markdown heading lines (e.g. "# Goal")
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .find(Boolean) ?? "";
  return planningTitle || activeProjectName || goalSentence || "New project";
}
