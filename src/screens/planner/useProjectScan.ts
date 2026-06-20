import { useEffect } from "react";
import { useAppStore } from "../../store";
import { scanProjectRepos, scanPlanSections } from "./projectScan";
import { canonicalSectionKey } from "./planSections";

/**
 * Refreshes the active project's linked repositories and plan whenever the
 * Projects tab is opened or the active project changes.
 *
 * Previously the full repo set was only derived when the board view mounted,
 * and the plan only when the planner ran — so opening a project elsewhere left
 * the stale ≤N repos from the projects-list query and an out-of-date plan. This
 * hook runs the resolution up front: repos are re-derived from project items
 * (the reliable source) and plan sections are re-read from disk. Both degrade
 * silently on error so an offline/empty state never clobbers existing data.
 *
 * Mount this once on the always-mounted Projects screen; the effect keys off
 * `activeScreen` + `activeProjectId`, so it fires on tab open and project switch
 * but is inert while other screens are showing.
 */
export function useProjectScan(): void {
  const activeScreen    = useAppStore(s => s.activeScreen);
  const activeProjectId = useAppStore(s => s.activeProjectId);

  useEffect(() => {
    if (activeScreen !== "projects" || !activeProjectId) return;
    let cancelled = false;

    // Clear the previously-open project's repos BEFORE scanning this one. `activeProjectRepos` is a
    // single global value that was never reset on switch — so one project's repos leaked into the
    // next project's auto-clone, cloning foreign repos into the wrong project dir (#…). The scan
    // below repopulates THIS project's repos; an empty result now correctly leaves it empty.
    useAppStore.getState().setActiveProjectRepos([]);

    void (async () => {
      // Read the rest from getState so a token/title change doesn't re-trigger
      // the scan — only a tab open or project switch should.
      const { githubToken, activeProjectName, setActiveProjectRepos, setPlanSection } =
        useAppStore.getState();

      // Repos — only overwrite when the scan found some, so a project with no
      // issues yet keeps whatever the projects-list query provided.
      if (githubToken) {
        try {
          const repos = await scanProjectRepos(githubToken, activeProjectId);
          if (!cancelled && repos.length > 0) setActiveProjectRepos(repos);
        } catch { /* offline / API error — keep existing repos */ }
      }

      // Plan — write only changed sections, mirroring the planner's poll. Keyed
      // by the project title, which is the planner's frozen session key.
      if (activeProjectName) {
        try {
          const sections = await scanPlanSections(activeProjectName);
          if (cancelled) return;
          const saved = useAppStore.getState().planSections[activeProjectName] ?? {};
          for (const [rawKey, content] of Object.entries(sections)) {
            // Canonicalize the file stem (e.g. a leftover "Tech stack.md" → "stack"), mirroring
            // the planner poll (Planning.tsx) — otherwise a title-named file is ingested as a
            // non-canonical section that blocks the Context gate (#803).
            const key = canonicalSectionKey(rawKey);
            if (content && content !== (saved[key] ?? "")) {
              setPlanSection(activeProjectName, key, content);
            }
          }
          // Collapse any pre-existing stale non-canonical keys already in the store (#803).
          useAppStore.getState().canonicalizePlanSections(activeProjectName);
        } catch { /* plans dir may not exist yet */ }
      }
    })();

    return () => { cancelled = true; };
  }, [activeScreen, activeProjectId]);
}
