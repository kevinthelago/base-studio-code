// Projects domain — page mode/view, active-project meta, drafts, startup-prompt + reference-context
// assignment, planning-session context, triage + fleet launch. Split from store/types (#1634).
import type { FleetPlan, AgentStream } from "@/features/planner/fleet/planFleet";

/** Projects slice of {@link AppStore}. */
export interface ProjectsState {
  // Projects (transient)
  projectsPageMode: "projects" | "fleet" | "dataModels";
  setProjectsPageMode: (v: "projects" | "fleet" | "dataModels") => void;
  // The Projects page is list ↔ planning (#499): the board moved to the GitHub
  // page (#498) and the execution tabs were removed.
  projectsView: "list" | "planning";
  setProjectsView: (v: "list" | "planning") => void;
  activeProjectId: string | null;
  activeProjectName: string;
  activeProjectRepo: string;
  activeProjectRepos: string[];
  activeProjectNumber: number;
  setActiveProject: (id: string | null) => void;
  setActiveProjectMeta: (id: string | null, name: string, repo: string, number: number, repos?: string[]) => void;
  setActiveProjectRepos: (repos: string[]) => void;
  // Purge a project's local footprint from the store: the per-project plan/config
  // maps and repo-scoped (`<key>::<repo>`) maps for every key in `keys` (pass the
  // planning session key — the title — and the GitHub id), plus the active-project
  // meta if it matches. Pairs with the backend delete_project_dir for the on-disk hub.
  deleteLocalProject: (keys: string[]) => void;
  /** New, not-yet-published projects (drafts, #379). Keyed by the planning session key
   *  (a unique `sanitize(title)-<id>` so a re-used title never inherits stale files). */
  localDraftProjects: Record<string, { title: string; pitch: string; createdAt: number }>;
  addDraftProject: (key: string, draft: { title: string; pitch: string; createdAt: number }) => void;
  /** Patch a draft record in place (#1222) — persists a title edit so it survives a reopen;
   *  keyed by the FROZEN key so the on-disk folder doesn't move. No-ops if the draft is gone. */
  updateDraftProject: (key: string, patch: Partial<{ title: string; pitch: string }>) => void;
  removeDraftProject: (key: string) => void;
  // Dev reset: clears all project/plan-scoped state (keeps auth, profiles, UI).
  resetProjectData: () => void;
  // GitHub project ids the user removed in-app (persisted). The Projects list is
  // re-fetched from GitHub on every sync, so without this a deleted-but-still-
  // returned project (closed, delete denied, or stale) would reappear. The list
  // is filtered against this set so removal sticks.
  hiddenProjectIds: string[];
  dismissProject: (id: string) => void;
  // Startup-prompt assignment (persisted). Values are unified-store document
  // relpaths, or null = inherit. Resolution: repo → project → global default →
  // built-in. See lib/startupPrompt.ts.
  defaultStartupPromptDoc: string | null;
  setDefaultStartupPromptDoc: (doc: string | null) => void;
  projectStartupPromptDoc: Record<string, string | null>;
  setProjectStartupPromptDoc: (projectId: string, doc: string | null) => void;
  repoStartupPromptDoc: Record<string, string | null>;
  setRepoStartupPromptDoc: (projectId: string, repo: string, doc: string | null) => void;
  // Reference-context assignment (persisted) — the SECOND assignment field from
  // lib/assignments.ts, distinct from the startup prompt above. These are the
  // documents injected as background context for a session. Unlike the startup
  // prompt (one doc, override cascade), reference context ACCUMULATES across the
  // default → project → repo levels. Stored as plain add-lists of relpaths; the
  // launch resolver (#326) lifts them into the assignments-module cascade.
  refContextDefault: string[];
  refContextProject: Record<string, string[]>;            // keyed by projectId
  refContextRepo: Record<string, string[]>;               // keyed by repoPromptKey
  /** Toggle a document into/out of the reference-context set at one scope.
   *  level "default" ignores the key; "project" keys by projectId; "repo" by
   *  repoPromptKey(projectId, repo). */
  toggleReferenceContext: (level: "default" | "project" | "repo", key: string | null, doc: string) => void;
  // Per-repo TRIAGE starting script (persisted). relpath of a unified-store doc,
  // or null. Used by triageStartProject for that repo's triage pane; falls back
  // to the verbatim TRIAGE_PROMPT when unset. Keyed by repoPromptKey.
  repoTriagePromptDoc: Record<string, string | null>;
  setRepoTriagePromptDoc: (projectId: string, repo: string, doc: string | null) => void;
  // The GitHub page's active top tab (summary | projects | repos), store-controlled
  // so other screens can deep-link to it (e.g. the Projects list signpost → projects).
  githubTab: string;
  setGithubTab: (t: string) => void;
  // The GitHub Projects v2 board now lives on the GitHub page (#498). When a project
  // is opened from the GitHub portfolio, this flips on and its board renders there
  // with `githubBoardTab` selecting the sub-view. Session-only (not persisted).
  githubBoardOpen: boolean;
  githubBoardTab: "board" | "roadmap" | "issues" | "insights";
  /** Open the GitHub-page board for the active project at a given sub-tab. */
  openGithubBoard: (tab?: "board" | "roadmap" | "issues" | "insights") => void;
  setGithubBoardTab: (t: "board" | "roadmap" | "issues" | "insights") => void;
  closeGithubBoard: () => void;
  projectsDrawerIssue: number | null;
  setProjectsDrawerIssue: (n: number | null) => void;
  planningPitch: string;
  planningRepo: string;
  planningTitle: string;
  setPlanningContext: (pitch: string, repo: string) => void;
  setPlanningTitle: (title: string) => void;
  // Stable per-session key for the planning directory, PTY slot, and plan
  // buckets. Frozen the moment a planning session begins so that neither the
  // publish flow assigning a GitHub Project id, nor the user editing the title,
  // can move the working directory out from under an active session.
  planningSessionKey: string;
  setPlanningSession: (key: string) => void;
  /** A prompt queued for the live planner session of a project, keyed by project key.
   *  Planning.tsx writes it into the planner PTY (a deliberate, user-triggered inject —
   *  e.g. the file-intake "Route" action) and clears it. (#604) */
  pendingPlannerPrompt: Record<string, string>;
  requestPlannerPrompt: (projectKey: string, text: string) => void;
  clearPlannerPrompt: (projectKey: string) => void;
  // Links a GitHub Project node id to the stable folder/data key (the title
  // slug the plan files were written under). A project opened from the board
  // only sets `activeProjectId` (the node id); this lets the planning resolver
  // find where the plan data actually lives instead of falling through to the
  // node id and rendering an empty pane. First-write-wins (see setActiveProjectMeta).
  projectKeyAlias: Record<string, string>;
  setProjectKeyAlias: (nodeId: string, key: string) => void;
  // project key -> structure node id -> linked GitHub issue (#393).
  issueLinks: Record<string, Record<string, { number: number; url: string }>>;
  // Merge links for a project (idempotent upsert; never drops existing entries).
  setIssueLinks: (projectKey: string, links: Record<string, { number: number; url: string }>) => void;
  // Repository resolution — base dir is `~/.base-studio-code` (the base); repo
  // clone paths are derived as `<base>/projects/<key>/<repo>`.
  bscBaseDir: string;
  setBscBaseDir: (dir: string) => void;
  projectLocalRepos: Record<string, string[]>;
  addProjectRepo: (projectId: string, fullName: string) => void;
  // `deltas` (#1004): optional per-repo (fullName → lead) since-last-run summary, prepended to
  // each pane's default triage prompt so a re-run resumes from what changed instead of re-ingesting.
  // Built by `prepareTriageRun` (which also records the new run marker) and passed in at launch.
  triageStartProject: (projectName: string, repos: string[], projectId?: string, deltas?: Record<string, string>) => void;
  // #1004: read each repo's last-triage marker + the since-then changed-issue delta from plan.db,
  // render a one-line resume lead per repo, and STAMP a fresh run marker (read-before-write). Keyed
  // by the project's plan.db key (effectiveProjectId). Returns the fullName → lead map for `deltas`.
  prepareTriageRun: (projectKey: string, repos: string[]) => Promise<Record<string, string>>;
  // Index of this project's triage tab, matched on its STABLE projectKey (#457) — not
  // the derived "· triage" name — so a rename never forks a duplicate. Pass the same
  // (projectName, projectId) used to launch it. -1 when none.
  findTriageTabIdx: (projectName: string, projectId?: string) => number;
  // Launch the agent fleet: a "· build" tab with the director (if enabled) at the
  // project root and one worker pane per launched stream in its repo clone. Path
  // keys off projectKey (the planning session key — where repos/prompts live).
  /** Launches the fleet; returns the fleet roster rows (paneId/stream/repo/branch/role TSV,
   *  one per live session) for the caller to persist via publishFleetRoster (#734). */
  fleetStartProject: (
    projectName: string,
    fleet: FleetPlan,
    projectKey: string,
    /** Authoritative absolute cwds from the Rust backend (#905): the hub dir
     *  (`project_dir_path`) for the director and each stream's worktree path
     *  (`ensure_worktree`) for its worker. Used verbatim so the launch never
     *  depends on the async-loaded `bscBaseDir` mirror; falls back to the
     *  `bscBaseDir`-derived path per pane when an entry is absent. */
    paths?: { hubPath?: string; worktreePaths?: Record<string, string> },
  ) => string[];
  // Index of this project's primary "· build" tab, matched on its STABLE projectKey
  // (#457) — pass the same projectKey used to launch the fleet. -1 when none.
  findFleetTabIdx: (projectKey: string) => number;
  // Coordination (#199 AC#7): paneId ("t{tab}p{pane}") → the AgentStream launched into
  // it. The coordination log keys waiters/producers by PANE id (BSC_AUDIT_PANE), but a
  // stream's produced contracts/issues/owned globs live on the stream by its slug. This
  // map bridges the two so the inbox can build a producer resolver (buildProducerOf) and
  // light up file/issue wait-for cycles. Written at fleet launch, persisted, global
  // (pane ids are unique across all tabs). Only worker panes are recorded.
  fleetPaneStreams: Record<string, AgentStream>;
}
