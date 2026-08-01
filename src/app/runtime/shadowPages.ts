// The shadow-mode page catalogue (#4169, epic #3604) — which graph page node corresponds to which source
// file, for every page the migration has touched.
//
// This is the pairing shadow mode compares. Each entry mirrors the generator that authored the records
// (`scripts/gen-<x>-graph.cjs`), which is the ONLY place the record ↔ file correspondence has lived until
// now — a mapping the generators use once and then forget. `shadowPages.test.ts` pins both halves so an
// entry cannot rot into a silent skip: a wrong file path or a dropped record id fails there rather than
// reading as "no drift".
//
// WHY THE FILE SOURCES ARE A RAW GLOB: the file half of the diff is the .tsx on disk, and the app has no
// filesystem access to its own source in a packaged build. Vite's `?raw` glob is the only way to have it
// at runtime — which is also why shadow mode is DEV-ONLY (see `shadowMode.ts`): the glob is reachable
// solely from a branch behind `import.meta.env.DEV`, so the production bundle carries none of it.
import type { RenderSource } from "@/shared/lib/runtime/shadow/shadowReport";

/** One module of a page: a graph record and the file it was transcribed from (`null` once that file has
 *  been deleted — the graph node is then the only copy and there is nothing to diff against). */
export interface ShadowModuleDef {
  recordId: string;
  file: string | null;
}

/** A page shadow mode can build from the graph and compare against its files. */
export interface ShadowPageDef {
  /** The graph page node's id — what `GraphComponent` mounts by. */
  pageId: string;
  label: string;
  /** What the app renders for this page TODAY (see `src/app/lazyWorkspaces.tsx`). Settings is the one
   *  page rolled BACK to files (#3758) after its graph version shipped, which is exactly the kind of
   *  fact this report exists to keep honest. */
  rendersFrom: RenderSource;
  modules: ShadowModuleDef[];
  /** Load the feature's injected platform surface, so the binding walk reads the registry the page would
   *  actually see. A feature registers its modules when its host module evaluates (`registerXPlatform()`
   *  at module load), so importing the feature's BARREL — the same thing a lazy workspace does on first
   *  visit — is what makes `unbound` mean what it says. Nothing is mounted; only modules evaluate. */
  ensurePlatform: () => Promise<unknown>;
}

/** The pages the graph carries, in rail order. */
export const SHADOW_PAGES: ShadowPageDef[] = [
  {
    pageId: "fleetpage",
    label: "Fleet",
    rendersFrom: "graph",
    // The files are GONE (#3636, the epic's first full cutover) — the graph node is the only copy, so
    // there is no structural baseline and only the binding half of the report applies.
    modules: [
      { recordId: "fleetpage", file: null },
      { recordId: "fleet-cost-energy", file: null },
      { recordId: "fleet-health", file: null },
      { recordId: "fleet-lessons", file: null },
    ],
    // Fleet's host is not on the planner barrel; Glance is the workspace that mounts it, and importing
    // that barrel evaluates `FleetGraphHost` → `registerFleetPlatform()`.
    ensurePlatform: () => import("@/features/glance"),
  },
  {
    pageId: "projectspage",
    label: "Projects",
    rendersFrom: "graph",
    modules: [{ recordId: "projectspage", file: "/src/features/planner/list/ProjectsList.tsx" }],
    // The ONE page that does not register when its module evaluates: `ProjectsGraphHost` registers at
    // first RENDER, to break an import cycle (see its comment). Shadow mode renders nothing, so it must
    // call the registration itself — without this the whole planner-list surface reads as unbound, which
    // is a 12-entry lie in the middle of the worklist this report exists to be.
    ensurePlatform: () => import("@/features/planner").then((m) => m.registerProjectsPlatform()),
  },
  {
    pageId: "githubpage",
    label: "GitHub",
    rendersFrom: "graph",
    modules: [
      { recordId: "githubpage", file: "/src/features/github/index.tsx" },
      { recordId: "github-empty", file: "/src/features/github/Empty.tsx" },
      { recordId: "github-summary", file: "/src/features/github/GitHubSummary.tsx" },
      { recordId: "github-pulse", file: "/src/features/github/Pulse.tsx" },
      { recordId: "github-branch-graph", file: "/src/features/github/BranchGraph.tsx" },
      { recordId: "github-activity-heatmap", file: "/src/features/github/summary/ActivityHeatmap.tsx" },
      { recordId: "github-ci-health", file: "/src/features/github/summary/CIHealthCard.tsx" },
      { recordId: "github-contributors", file: "/src/features/github/summary/ContributorsCard.tsx" },
      { recordId: "github-cross-repo-activity", file: "/src/features/github/summary/CrossRepoActivity.tsx" },
      { recordId: "github-page-mode-strip", file: "/src/features/github/summary/GitHubPageModeStrip.tsx" },
      { recordId: "github-language-mix", file: "/src/features/github/summary/LanguageMix.tsx" },
      { recordId: "github-open-prs", file: "/src/features/github/summary/OpenPRsCard.tsx" },
      { recordId: "github-repos-grid", file: "/src/features/github/summary/ReposGrid.tsx" },
    ],
    ensurePlatform: () => import("@/features/github"),
  },
  {
    pageId: "automationspage",
    label: "Automations",
    rendersFrom: "graph",
    modules: [
      { recordId: "automationspage", file: "/src/features/automations/index.tsx" },
      { recordId: "automations-schedules", file: "/src/features/automations/Schedules.tsx" },
      { recordId: "automations-history", file: "/src/features/automations/History.tsx" },
      { recordId: "automations-hook-analytics", file: "/src/features/automations/HookAnalytics.tsx" },
    ],
    ensurePlatform: () => import("@/features/automations"),
  },
  {
    pageId: "mcppage",
    label: "MCP",
    rendersFrom: "graph",
    modules: [
      { recordId: "mcppage", file: "/src/features/mcp/index.tsx" },
      { recordId: "mcp-analytics", file: "/src/features/mcp/McpAnalytics.tsx" },
    ],
    ensurePlatform: () => import("@/features/mcp"),
  },
  {
    pageId: "skillspage",
    label: "Skills",
    rendersFrom: "graph",
    modules: [
      { recordId: "skillspage", file: "/src/features/skills/index.tsx" },
      { recordId: "skills-views", file: "/src/features/skills/SkillsViews.tsx" },
      { recordId: "skills-new-group-dialog", file: "/src/features/skills/NewGroupDialog.tsx" },
      { recordId: "skills-drawer", file: "/src/features/skills/SkillDrawer.tsx" },
      { recordId: "skills-digest", file: "/src/features/skills/SkillsDigest.tsx" },
      { recordId: "skills-lessons-tab", file: "/src/features/skills/LessonsTab.tsx" },
      { recordId: "skills-runs-tab", file: "/src/features/skills/RunsTab.tsx" },
    ],
    ensurePlatform: () => import("@/features/skills"),
  },
  {
    pageId: "securitypage",
    label: "Security",
    rendersFrom: "graph",
    modules: [
      { recordId: "securitypage", file: "/src/features/security/index.tsx" },
      { recordId: "security-profiles", file: "/src/features/security/ProfilesTab.tsx" },
      { recordId: "security-assignments", file: "/src/features/security/AssignmentsTab.tsx" },
      { recordId: "security-activity", file: "/src/features/security/ActivityTab.tsx" },
      { recordId: "security-flow", file: "/src/features/security/FlowTab.tsx" },
    ],
    ensurePlatform: () => import("@/features/security"),
  },
  {
    pageId: "settingspage",
    label: "Settings",
    // ROLLED BACK to the hand-coded pages (#3758). The graph records + host are still there, dormant —
    // so this is the page whose shadow report matters most: it is the one that came back.
    rendersFrom: "file",
    modules: [
      { recordId: "settingspage", file: "/src/features/settings/index.tsx" },
      { recordId: "settings-general", file: "/src/features/settings/pages/GeneralPage.tsx" },
      { recordId: "settings-planner", file: "/src/features/settings/pages/PlannerPage.tsx" },
      { recordId: "settings-skills", file: "/src/features/settings/pages/SkillsPage.tsx" },
      { recordId: "settings-automations", file: "/src/features/settings/pages/AutomationsPage.tsx" },
      { recordId: "settings-mcp", file: "/src/features/settings/pages/McpPage.tsx" },
      { recordId: "settings-github", file: "/src/features/settings/pages/GithubPage.tsx" },
      { recordId: "settings-security", file: "/src/features/settings/pages/SecurityPage.tsx" },
    ],
    ensurePlatform: () => import("@/features/settings"),
  },
];

/** The file half of the diff, lazily. Keys are project-root-absolute paths, matching `ShadowModuleDef.file`.
 *  Enumerated per page rather than by a wide `features/**` pattern: a broad raw glob would make a module
 *  out of every component file in the app. */
const FILE_SOURCES = import.meta.glob<string>(
  [
    "/src/features/planner/list/ProjectsList.tsx",
    "/src/features/github/{index,Empty,GitHubSummary,Pulse,BranchGraph}.tsx",
    "/src/features/github/summary/{ActivityHeatmap,CIHealthCard,ContributorsCard,CrossRepoActivity,GitHubPageModeStrip,LanguageMix,OpenPRsCard,ReposGrid}.tsx",
    "/src/features/automations/{index,Schedules,History,HookAnalytics}.tsx",
    "/src/features/mcp/{index,McpAnalytics}.tsx",
    "/src/features/skills/{index,SkillsViews,NewGroupDialog,SkillDrawer,SkillsDigest,LessonsTab,RunsTab}.tsx",
    "/src/features/security/{index,ProfilesTab,AssignmentsTab,ActivityTab,FlowTab}.tsx",
    "/src/features/settings/index.tsx",
    "/src/features/settings/pages/{GeneralPage,PlannerPage,SkillsPage,AutomationsPage,McpPage,GithubPage,SecurityPage}.tsx",
  ],
  { query: "?raw", import: "default" },
);

/** The paths the glob resolved — the catalogue test's other half. */
export function globbedFiles(): string[] {
  return Object.keys(FILE_SOURCES).sort();
}

/** The file copy of a module's source, or `null` when the entry declares no file (a deleted baseline) or
 *  the path matches nothing (which the catalogue test makes impossible to ship). */
export async function loadFileSource(path: string | null): Promise<string | null> {
  if (!path) return null;
  const loader = FILE_SOURCES[path];
  return loader ? await loader() : null;
}
