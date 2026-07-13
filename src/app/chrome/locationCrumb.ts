// The top-left "you are here" location crumb (#3036) — the sub-page detail appended after the
// Workspace name (from `registry.ts`) in the titlebar (`App.tsx` → `Titlebar`). Pure + unit-tested so
// EVERY navigable page is reflected, not just a few.
//
// Every workspace's active page IS in the store: an uncontrolled `<Screen>` persists it at
// `activePageTab[pageKey]` (`usePageTabs`), the controlled ones use a dedicated field
// (`projectsPageMode` / `githubTab` / `settingsSection`), and the console uses its own tab array.
//
// The page-label maps below MIRROR each feature's TabItem labels (glance `GLANCE_TABS`, skills
// `SKILL_TABS`, automations `defs`, mcp `tabDefs`, security `agentDefs`, github `GITHUB_TABS`, planner
// `PROJECT_MODES`, settings `SECTIONS`). They live here (not imported) so the shell doesn't reach into
// every feature's internals; an id with no entry Title-Cases gracefully, so a newly-added tab is still
// labeled (never blank), just less pretty than a curated name.

import { workspaceLabel, type Workspace } from "@/app/registry";

/** Title-case a page id as a graceful fallback for an unmapped tab: `hook-analytics` → `Hook Analytics`. */
export function titleCasePageId(id: string): string {
  return id.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** Per-workspace page-id → label for the UNCONTROLLED Screens (active id in `activePageTab[pageKey]`). */
const PAGES: Partial<Record<Workspace, Record<string, string>>> = {
  glance:     { network: "Network", fleet: "Fleet" },
  skills:     { library: "Library", lessons: "Lessons", runs: "Runs" },
  automation: { schedules: "Schedules", history: "History", hooks: "Hooks", analytics: "Hook Analytics" },
  mcp:        { installed: "Installed", catalog: "Catalog", analytics: "Analytics" },
  security:   { profiles: "Profiles", assignments: "Assignments", activity: "Activity", flow: "Flow" },
};
/** Planner sub-page (`projectsPageMode`) → label (mirrors `PROJECT_MODES`). */
const PLANNER_PAGES: Record<string, string> = { projects: "Projects", teams: "Teams", designs: "Components", algorithms: "Algorithms" };
/** GitHub tab (`githubTab`) → label (mirrors `GITHUB_TABS`). */
const GITHUB_TABS: Record<string, string> = { summary: "Summary", projects: "Projects", repos: "Repositories" };
/** GitHub board-drill (`githubBoardTab`) → label. */
const GITHUB_BOARD: Record<string, string> = { board: "Board", roadmap: "Roadmap", issues: "Issues", insights: "Insights" };
/** Settings section (`settingsSection`) → label (mirrors `SECTIONS`). */
const SETTINGS_SECTIONS: Record<string, string> = { general: "General", planner: "Planner", skills: "Skills", automations: "Automations", mcp: "MCP", github: "GitHub", security: "Security" };

/** The `activePageTab` key when it differs from the Workspace key (only automations does). */
const PAGE_KEY: Partial<Record<Workspace, string>> = { automation: "automations" };
/** The default first tab per uncontrolled workspace — so the crumb shows the current page even before
 *  the user has ever selected one (`activePageTab` is empty until the first click). Mirrors each feature's
 *  first `TabItem` id. */
const DEFAULT_PAGE: Partial<Record<Workspace, string>> = {
  glance: "network", skills: "library", automation: "schedules", mcp: "installed", security: "profiles",
};

const label = (map: Record<string, string>, id: string | undefined): string =>
  id ? (map[id] ?? titleCasePageId(id)) : "";

/** The store fields the crumb reads — kept explicit (a subset of `AppStore`) so it's trivially testable. */
export interface CrumbState {
  activeWorkspace: Workspace;
  activePageTab: Record<string, string>;
  /** The navigated ENTITY per graph, keyed by page id (`glance`/`teams`/`designs`/`algorithms`),
   *  reported by each graph via `useCrumbEntity` (#3041). Appended after the page name. */
  crumbEntity: Record<string, string>;
  projectsPageMode: string;
  projectsView: string;
  githubTab: string;
  githubBoardOpen: boolean;
  githubBoardTab: string;
  activeRepoName?: string;
  settingsSection: string;
  /** The active console tab's name (`tabs[activeTabIdx]?.name`). */
  consoleTab?: string;
  focusedAgentName?: string;
}

/**
 * The full "you are here" crumb: the Workspace's canonical name (`registry.ts`) followed by its active
 * PAGE label — and, where meaningful, one more detail (the focused console agent, the GitHub repo, the
 * planning session). Every workspace's page is reflected. Parts are joined with " — ".
 */
export function locationCrumb(s: CrumbState): string {
  const w = s.activeWorkspace;
  const parts: string[] = [workspaceLabel(w)];
  switch (w) {
    case "console":
      if (s.consoleTab) parts.push(s.consoleTab);
      if (s.focusedAgentName) parts.push(s.focusedAgentName);
      break;
    case "glance":
      parts.push(label(PAGES.glance ?? {}, s.activePageTab.glance ?? DEFAULT_PAGE.glance));
      if (s.crumbEntity.glance) parts.push(s.crumbEntity.glance); // the drilled project
      break;
    case "skills":
    case "mcp":
    case "security":
    case "automation":
      parts.push(label(PAGES[w] ?? {}, s.activePageTab[PAGE_KEY[w] ?? w] ?? DEFAULT_PAGE[w]));
      break;
    case "projects":
      parts.push(label(PLANNER_PAGES, s.projectsPageMode));
      if (s.projectsPageMode === "projects") {
        // Inside the Projects tab, a live planning session is a distinct place worth naming.
        if (s.projectsView === "planning") parts.push("Planning");
      } else if (s.crumbEntity[s.projectsPageMode]) {
        // Teams / Components / Algorithms → the entered team, active kit, active language.
        parts.push(s.crumbEntity[s.projectsPageMode]);
      }
      break;
    case "github":
      // A full-page board drill (Board/Roadmap/Issues/Insights) sits OVER the tabs when open.
      parts.push(s.githubBoardOpen ? label(GITHUB_BOARD, s.githubBoardTab) : label(GITHUB_TABS, s.githubTab));
      if (s.activeRepoName) parts.push(s.activeRepoName);
      break;
    case "settings":
      parts.push(label(SETTINGS_SECTIONS, s.settingsSection));
      break;
  }
  return parts.filter(Boolean).join(" — ");
}
