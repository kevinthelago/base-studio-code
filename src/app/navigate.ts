// navigate (#3602) — ONE place that turns "go here" into the right store mutations, so navigation can
// never forget the page.
//
// WHY THIS EXISTS
// A Workspace switch (`setWorkspace`) and the PAGE within it (which tab/section) are set through
// DIFFERENT mechanisms per workspace — tabbed screens persist an uncontrolled `activePageTab[key]`,
// the rest each own a dedicated field (`projectsPageMode`, `githubTab`, `automationsTab`,
// `settingsSection`). So a caller that just did `setWorkspace("glance")` lands on whatever tab was last
// open, not the one it meant — #3598 was FOUR separate one-off fixes for exactly this (triage-complete
// landing on Glance but not the Network tab / not the project, GitHub-connect banner landing on the
// last settings section, …). `navigate({ workspace, page, drill })` makes "specify the page" STRUCTURAL:
// you name the page in the same call that switches the workspace, and this module knows which knob each
// workspace turns.
import type { AppStore } from "@/store/types";
import type { Workspace } from "@/app/registry";

/** A navigation target: WHERE (workspace) + WHICH page within it + an optional entity to focus.
 *  `workspace` is required — the whole point is that you cannot switch screens without saying which
 *  page, so "land on glance" can never silently mean "…on whatever tab happened to be open". */
export interface NavLoc {
  workspace: Workspace;
  /** The page/tab within the workspace. Omit only for a workspace with no pages (console — its tabs are
   *  index-switched, not a string page) or when the workspace's default page is genuinely what you want. */
  page?: string;
  /** An entity to focus on the landing screen (currently only Glance, which drills into a project). Pass
   *  `null` to clear a drill; omit to leave it untouched. */
  drill?: string | null;
}

/** How each workspace sets its current PAGE — the single source of truth for a workspace's page knob.
 *  Tabbed screens (glance/skills/mcp/security) persist an uncontrolled `activePageTab[key]`; the rest own
 *  a dedicated field. `console` is intentionally absent: its "pages" are indexed tabs switched by
 *  `setActiveTab(idx)`, not a string page — a `navigate` to console carries no `page`. */
const WORKSPACE_PAGE: Partial<Record<Workspace, (s: AppStore, page: string) => void>> = {
  glance: (s, page) => s.setActivePageTab("glance", page),
  skills: (s, page) => s.setActivePageTab("skills", page),
  mcp: (s, page) => s.setActivePageTab("mcp", page),
  security: (s, page) => s.setActivePageTab("security", page),
  projects: (s, page) => s.setProjectsPageMode(page as AppStore["projectsPageMode"]),
  github: (s, page) => s.setGithubTab(page),
  automation: (s, page) => s.setAutomationsTab(page as AppStore["automationsTab"]),
  settings: (s, page) => s.setSettingsSection(page),
};

/** How each workspace focuses an ENTITY. Only Glance drills today; the map keeps the door open. */
const WORKSPACE_DRILL: Partial<Record<Workspace, (s: AppStore, id: string | null) => void>> = {
  glance: (s, id) => s.setGlanceDrill(id),
};

/** Set the page for `workspace` through its own mechanism. Exported so the `bsc navigate` bridge routes
 *  through the SAME map instead of hard-coding one workspace's setter. A workspace with no page
 *  mechanism (console) is a no-op. */
export function dispatchPage(s: AppStore, workspace: Workspace, page: string): void {
  WORKSPACE_PAGE[workspace]?.(s, page);
}

/**
 * Apply a navigation: focus the entity, set the page, THEN switch the workspace — in that order, so the
 * target screen mounts already showing the right page/entity rather than flashing its last-viewed one.
 * Pure over the store (every mutation is a store setter), so it is unit-testable with a fake store.
 */
export function applyNavigation(s: AppStore, loc: NavLoc): void {
  if (loc.drill !== undefined) WORKSPACE_DRILL[loc.workspace]?.(s, loc.drill);
  if (loc.page !== undefined) dispatchPage(s, loc.workspace, loc.page);
  s.setWorkspace(loc.workspace);
}
