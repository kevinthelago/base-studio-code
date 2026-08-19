// The shadow-mode page catalogue (#4169, epic #3604) — which graph page node corresponds to which source
// file, for every page the migration has touched.
//
// This is the pairing shadow mode compares. It used to mirror the generator that authored the records
// (`scripts/gen-<x>-graph.cjs`); those were RETIRED (graph-retire-shadow-and-generators) because they
// `readFileSync` source files this migration deletes, so this catalogue is now the pairing's home rather
// than its copy. `shadowPages.test.ts` pins both halves so an entry cannot rot into a silent skip: a
// wrong file path or a dropped record id fails there rather than reading as "no drift".
//
// HOW A FILE LEAVES. `file: null` is the designed end state, not a special case — it says the file is
// gone and the record is the only copy, so the STRUCTURAL half of the report drops and the BINDING half
// (does the record resolve its imports?) keeps running. Shadow mode therefore never needs retiring: it
// shrinks as the migration proceeds and its structural half self-retires when the last entry goes null.
// There is deliberately NO replacement baseline — an archive copy or a previous record revision would
// be a copy of the thing under test, which is not a second opinion. `bsc ui parity` (#4246) answers the
// question that outlives the file: does the app RENDER what it SHIPS (store vs seed)?
//
// ── `graphParity.test.ts` IS RETIRED (retire-graphparity). Do not recreate it. ────────────────────
//
// It asserted that every record's CODE equals its source file's code, and it was written for two real
// user-visible bugs: #4174 (a `security-flow` record still telling users to run a command #1039 had
// removed, corrected in the file only) and #4179 (Skills drifting BOTH ways in a single day while the
// suite stayed green, because #3854's own test asserted against a component nobody mounts).
//
// It was retired for a reason that will look like a bug if you rediscover it cold: at the end it was
// failing for ~210 of the 299 records that still had a file, and almost none of those were drift. A
// record must render STANDALONE in the preview sandbox, so it inlines what it cannot resolve and relaxes
// required props — `backbutton`'s record defines `ChevronLeft` where the file imports it, and makes
// `onClick`/`aria-label` optional. 156 of those records carry a transcription/inlining header saying so.
// Record-only content is DESIGNED (the three-way merges preserved `loading`/`error` props the file never
// had), so "the record's code equals the file's code" is not a stale assertion — it contradicts a
// deliberate decision. Narrowing it to records that still have a file removes almost nothing.
//
// WHAT NOW COVERS WHAT, stated so the gap is visible rather than assumed:
//   * `bsc ui parity` (#4246)        — store vs SEED. Does the app render what it ships?
//   * `e2e/recordLinks.spec.ts`      — every record compiles and every specifier it needs resolves.
//   * `e2e/graphPages.spec.ts`       — every page record exports a component.
//   * `e2e/graphPrimitive.spec.ts`   — the record, not the bundled file, is what the renderer mounts.
// NONE of them can see "the file was corrected and the record was not". That risk is ACCEPTED for as
// long as both copies exist, and it disappears with the file — which is the direction of travel.
// `projectsGraphSeed.test.ts` went with it: same class, and it had stopped running entirely because its
// `ProjectsList.tsx?raw` baseline no longer exists. Its surviving question — does every specifier the
// record imports resolve? — is what `recordLinks` now asks of every record, not just that one.
//
// Entries are nulled HERE, ahead of the deletion, because this file belongs to the design-studio stream
// while each deletion item is scoped to its own feature glob — a github worker cannot edit this file, so
// leaving the flip to the deletion would make every deletion item fail a test it has no way to fix.
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
  /** What the app renders for this page TODAY — read back from `src/app/lazyWorkspaces.tsx` by
   *  `shadowPages.test.ts` rather than declared on trust, because it is the context every verdict is
   *  read against: `differs` on a graph-rendered page is a live bug, the same verdict on a file-rendered
   *  one is a not-yet. Every entry is `"graph"` today and the field still is not redundant — a page CAN
   *  be flipped back, as Settings was (#3758). What Settings then showed is that a `"file"` entry is a
   *  DECISION PENDING, not a resting state: a graph copy nothing renders only rots, so Settings' was
   *  deleted outright (#4183) and the page left this catalogue rather than sitting here as `"file"`. */
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
    pageId: "accessibilitypage",
    label: "Accessibility",
    // The ONLY file-rendered entry, and deliberately so. Settings was rolled back to files (#3758) and its
    // `settingspage` graph copy deleted (#4183) — but this record is not that leftover: it was promoted
    // into the seed on 2026-08-11, ten days later, alongside the whole `features/settings/cards/*` family.
    // So the record is live and the SCREEN renders from the file, which is what `rendersFrom` exists to
    // say: a `differs` verdict here is a not-yet, not a live problem.
    rendersFrom: "file",
    modules: [
      { recordId: "accessibilitypage", file: null }, // RETIRED — the record is the only copy,
    ],
    ensurePlatform: () => import("@/features/settings/graphPlatform").then((m) => m.registerSettingsPlatform()),
  },
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
    ensurePlatform: () => import("@/features/glance/graphPlatform").then((m) => m.registerGlancePlatform()),
  },
  {
    pageId: "consolepage",
    label: "Console",
    rendersFrom: "graph",
    modules: [
      { recordId: "consolepage", file: null },
      { recordId: "console-pane-at", file: null },
      { recordId: "console-pane-shell", file: null },
      { recordId: "console-pane-menu", file: null }, // RETIRED — the record is the only copy,
      { recordId: "console-states", file: null },
    ],
    // The shell is not a feature and has no barrel — the host module IS the registration.
    ensurePlatform: () => import("@/app/console/ConsoleGraphHost"),
  },
  {
    pageId: "planningpage",
    label: "Planning",
    // The planner Screen mounts this one with `visible` and keeps it MOUNTED across tabs (#4224).
    rendersFrom: "graph",
    modules: [
      { recordId: "planningpage", file: null },
      { recordId: "planning-header", file: null },
      { recordId: "planning-notices", file: null },
      { recordId: "planning-dialogs", file: null },
      { recordId: "planning-publish-progress", file: null },
      { recordId: "planning-injection-gate", file: null },
      { recordId: "planning-github-structure", file: null }, // RETIRED — the record is the only copy,
      // The focused project pane (#4227) — the plan half of this page. These are `provides` records, not
      // `@/components/<id>` siblings, so the page composes them without naming a single one: it imports
      // `@/features/planner/pane/ProjectPane` exactly as it did when that was a code module, and the
      // resolver reaches the graph first. Listed here so they fall under the parity guard like the rest.
      { recordId: "plan-pane", file: null },
      { recordId: "plan-pane-shell", file: null },
      { recordId: "plan-pane-bodies", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-pane-stage-bar", file: null },
      { recordId: "plan-pane-rail", file: null },
      { recordId: "plan-pane-mcp-modal", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-pane-primitives", file: null }, // RETIRED — the record is the only copy,
      // The stage bodies (#4230) — the pane's body switch reaches these, and they reach each other,
      // all by `provides`. Every file in that directory is here: it was checked for unreached
      // components before scoping, and unlike `pane/` it had none.
      { recordId: "plan-body-discovery", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-market", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-transformations", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-automations", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-skills", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-mcps", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-features", file: null }, // RETIRED — the record is the only copy
      { recordId: "plan-body-file-intake", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-deployment", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-deploy-card", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-deploy-ship", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-deploy-target", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-deploy-primitives", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-source", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-scan-views", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-connector-form", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-streams", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-permissions", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-plan", file: null }, // RETIRED — the record is the only copy
      { recordId: "plan-body-stream-cards", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-shared-deps", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-collapsible-card", file: null }, // RETIRED — the record is the only copy,
      { recordId: "plan-body-primitives", file: null }, // RETIRED — the record is the only copy,
    ],
    ensurePlatform: () => import("@/features/planner/graphPlatform").then((m) => m.registerPlannerPlatform()),
  },
  {
    pageId: "algorithmspage",
    label: "Algorithms",
    // Planner-mounted, like Sounds — not a rail Workspace (#4219).
    rendersFrom: "graph",
    modules: [
      { recordId: "algorithmspage", file: null }, // RETIRED — the record is the only copy,
      { recordId: "algorithms-rail", file: null }, // RETIRED — the record is the only copy,
      { recordId: "algorithms-inspector", file: null }, // RETIRED — the record is the only copy,
      { recordId: "algorithms-kit-graph", file: null }, // RETIRED — the record is the only copy,
      { recordId: "algorithms-librarian-terminal", file: null }, // RETIRED — the record is the only copy,
    ],
    ensurePlatform: () => import("@/features/algorithms/graphPlatform").then((m) => m.registerAlgorithmsPlatform()),
  },
  {
    pageId: "soundspage",
    label: "Sounds",
    // Not a rail Workspace — the planner Screen mounts this one as a tab (#4215).
    rendersFrom: "graph",
    modules: [
      { recordId: "soundspage", file: null }, // RETIRED — the record is the only copy,
      { recordId: "sounds-rail", file: null }, // RETIRED — the record is the only copy,
      { recordId: "sounds-inspector", file: null }, // RETIRED — the record is the only copy,
      { recordId: "sounds-kit-graph", file: null }, // RETIRED — the record is the only copy,
    ],
    ensurePlatform: () => import("@/features/sounds/graphPlatform").then((m) => m.registerSoundsPlatform()),
  },
  {
    pageId: "glancepage",
    label: "Glance",
    rendersFrom: "graph",
    modules: [
      { recordId: "glancepage", file: null }, // RETIRED — the record is the only copy,
      { recordId: "glance-canvas", file: null }, // RETIRED — the record is the only copy,
      { recordId: "glance-stream-morph", file: null }, // RETIRED — the record is the only copy,
      { recordId: "glance-preview-morph", file: null }, // RETIRED — the record is the only copy,
      { recordId: "glance-node", file: null }, // RETIRED — the record is the only copy,
      { recordId: "glance-plan-screen", file: null }, // RETIRED — the record is the only copy,
      { recordId: "glance-chat-dock", file: null }, // RETIRED — the record is the only copy,
      { recordId: "glance-session-log", file: null }, // RETIRED — the record is the only copy,
    ],
    ensurePlatform: () => import("@/features/glance/graphPlatform").then((m) => m.registerGlancePlatform()),
  },
  {
    pageId: "projectspage",
    label: "Projects",
    rendersFrom: "graph",
    modules: [
      { recordId: "projectspage", file: null },
      // The list's components (#4232) — `provides` records, like `pane/` and `bodies/`. Authoring them
      // is what the page's regeneration to ABSOLUTE specifiers unlocked: `provides` matches the exact
      // specifier a record imports, so while the page said `./ProjectCard` none of these was reachable.
      { recordId: "projects-card", file: null },
      { recordId: "projects-rail", file: null },
      { recordId: "projects-setup", file: null },
      { recordId: "projects-blueprint-card", file: null },
      { recordId: "projects-cloud-blueprints", file: null },
      { recordId: "projects-reopen-modal", file: null }, // RETIRED — the record is the only copy,
      { recordId: "projects-delete-modal", file: null },
    ],
    // The ONE page that does not register when its module evaluates: `ProjectsGraphHost` registers at
    // first RENDER, to break an import cycle (see its comment). Shadow mode renders nothing, so it must
    // call the registration itself — without this the whole planner-list surface reads as unbound, which
    // is a 12-entry lie in the middle of the worklist this report exists to be.
    ensurePlatform: () => import("@/features/planner/graphPlatform").then((m) => m.registerPlannerPlatform()).then(() => import("@/features/planner/list/graphPlatform").then((b) => b.registerProjectsPlatform())),
  },
  {
    pageId: "githubpage",
    label: "GitHub",
    rendersFrom: "graph",
    modules: [
      // Graph-only for the same reason as automationspage/mcppage/securitypage: the file copy was
      // dead and was removed, and the barrel is index.ts now. The six part modules keep their files.
      { recordId: "githubpage", file: null },
      // Empty/GitHubSummary/Pulse are RELEASED FOR DELETION (graph-retire-shadow-and-generators): their
      // records are settled against the seed, so the file has no second opinion left to give, and the
      // per-stream deletion item cannot null these itself — it does not own this file. Nulled here so
      // `git rm` in `src/features/github/**` is all that item has to do.
      { recordId: "github-empty", file: null },
      { recordId: "github-summary", file: null },
      // Pulse.tsx backs NINE records; only this one is catalogued, so its deletion also needs
      // `reconcile-record-src.cjs --retire` to move the other eight off `src`.
      { recordId: "github-pulse", file: null },
      { recordId: "github-branch-graph", file: null },
      { recordId: "github-activity-heatmap", file: null },
      { recordId: "github-ci-health", file: null },
      { recordId: "github-contributors", file: null },
      { recordId: "github-cross-repo-activity", file: null },
      { recordId: "github-page-mode-strip", file: null },
      { recordId: "github-language-mix", file: null },
      { recordId: "github-open-prs", file: null },
      { recordId: "github-repos-grid", file: null },
    ],
    ensurePlatform: () => import("@/features/github/graphPlatform").then((m) => m.registerGithubPlatform()),
  },
  {
    pageId: "automationspage",
    label: "Automations",
    rendersFrom: "graph",
    modules: [
      // Graph-only: the dead AutomationsWorkspace copy is gone and the barrel is index.ts now, so
      // this path would not resolve. The three tab bodies below are still real files.
      { recordId: "automationspage", file: null },
      // Schedules.tsx is GONE. It was held back while `automations-schedules` was one of the 50
      // unresolved in `graph-srctext-three-way-merges` — the .tsx was a party to that merge. The merge
      // has landed, so the record is the only copy and there is nothing left to diff against.
      { recordId: "automations-schedules", file: null },
      { recordId: "automations-history", file: null },
      { recordId: "automations-hook-analytics", file: null },
    ],
    ensurePlatform: () => import("@/features/automations/graphPlatform").then((m) => m.registerAutomationsPlatform()),
  },
  {
    pageId: "mcppage",
    label: "MCP",
    rendersFrom: "graph",
    modules: [
      // The file baseline is gone: index.tsx still exists, but only as the feature's barrel (lib
      // re-exports + the unmigrated HooksView). Its McpWorkspace copy was dead — both shells mount
      // the record through McpGraphHost — so it was removed. Diffing the record against what is
      // left would report `differs` forever against a file that no longer claims to be this page.
      { recordId: "mcppage", file: null },
      { recordId: "mcp-analytics", file: null },
    ],
    ensurePlatform: () => import("@/features/mcp/graphPlatform").then((m) => m.registerMcpPlatform()),
  },
  {
    pageId: "skillspage",
    label: "Skills",
    rendersFrom: "graph",
    modules: [
      { recordId: "skillspage", file: null }, // RETIRED — the record is the only copy,
      // and its file was the last un-trimmed *Workspace duplicate (retire-the-dead-skills-
      // workspace-copy). #4179 is what the second copy cost.
      { recordId: "skills-views", file: null }, // RETIRED — the record is the only copy,
      { recordId: "skills-new-group-dialog", file: null }, // RETIRED — the record is the only copy,
      { recordId: "skills-drawer", file: null }, // RETIRED — the record is the only copy,
      { recordId: "skills-digest", file: null }, // RETIRED — the record is the only copy,
      { recordId: "skills-lessons-tab", file: null }, // RETIRED — the record is the only copy,
      { recordId: "skills-runs-tab", file: null }, // RETIRED — the record is the only copy,
    ],
    ensurePlatform: () => import("@/features/skills/graphPlatform").then((m) => m.registerSkillsPlatform()),
  },
  {
    pageId: "securitypage",
    label: "Security",
    rendersFrom: "graph",
    modules: [
      // Same as mcppage: the dead SecurityWorkspace copy is gone and what survives is the feature's
      // re-export barrel — now index.ts, so this path would not even resolve.
      { recordId: "securitypage", file: null },
      // Profiles/Activity/Flow were the last three files HELD by graph-srctext-three-way-merges — their
      // .tsx was a party to the merge. The merge landed and the files are deleted, so their records are
      // the only copy. AssignmentsTab.tsx was the last tab body with a file and is now retired too, so
      // this page is wholly record-only.
      { recordId: "security-profiles", file: null },
      { recordId: "security-assignments", file: null }, // RETIRED — the record is the only copy,
      { recordId: "security-activity", file: null },
      { recordId: "security-flow", file: null },
    ],
    ensurePlatform: () => import("@/features/security/graphPlatform").then((m) => m.registerSecurityPlatform()),
  },
];

/** The file half of the diff, lazily. Keys are project-root-absolute paths, matching `ShadowModuleDef.file`.
 *  Enumerated per page rather than by a wide `features/**` pattern: a broad raw glob would make a module
 *  out of every component file in the app. */
const FILE_SOURCES = import.meta.glob<string>(
  [
    "/src/features/planner/list/ReopenProjectModal.tsx",
    "/src/features/planner/session/GitHubStructureCard.tsx",
    "/src/features/planner/pane/FocusedBodies.tsx",
    // Named, not `bodies/*.tsx` — the glob is the file half of the parity diff, and a wildcard sweeps up
    // the directory's twelve `.test.tsx` files, which the catalogue guard correctly rejects as globbed
    // sources nothing declares.
    "/src/features/planner/bodies/StreamsBody.tsx",
    "/src/features/sounds/Sounds{Workspace,Rail,Inspector,KitGraph}.tsx",
    "/src/features/algorithms/AlgorithmsWorkspace.tsx",
    "/src/app/console/panes/PaneMenu.tsx",
    // Empty/GitHubSummary/Pulse dropped with their entries — the glob and the catalogue are pinned to
    // each other BOTH ways by `shadowPages.test.ts`, so a path released for deletion has to leave both.
    // Schedules.tsx dropped with its entry — automations now contributes no file baseline at all.
    // McpAnalytics dropped with its entry.
    // skills/index.tsx dropped with its entry — the barrel is index.ts now and holds no component.
    // ProfilesTab/ActivityTab/FlowTab dropped with their entries — AssignmentsTab is the last security file.
    "/src/features/security/AssignmentsTab.tsx",
    // The one file-rendered page (see its entry) — Settings renders this .tsx while the record shadows it.
    "/src/features/settings/pages/AccessibilityPage.tsx",
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
