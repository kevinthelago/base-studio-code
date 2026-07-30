// Projects domain — page mode/view, active-project meta, drafts, startup-prompt + reference-context
// assignment, planning-session context, triage + fleet launch. Split from store/types (#1634).
import type { FleetPlan, AgentStream } from "@/features/planner/fleet/planFleet";
import type { ProjectLink, ContractTarget } from "@/features/glance/lib/projectLinks";
import type { GEdgeKind, GRole, GHealth, GActivity } from "@/features/glance/lib/glanceGraph";
import type { PreviewSource } from "@/shared/lib/preview/previewSource";
import type { ReviewFinding } from "@/shared/lib/preview/previewReview";

/** Projects slice of {@link AppStore}. */
export interface ProjectsState {
  // Projects (transient). "designs" is the Designs studio page (#move-to-planner) — formerly its own rail
  // Workspace, folded in as a Planner tab; it owns the structure axis AND, since #2834, the theme try-on,
  // so the standalone "themes" tab was retired (#2850). "algorithms" is the knowledge graph, folded in
  // the same way (formerly its own rail Workspace).
  projectsPageMode: "projects" | "teams" | "designs" | "algorithms" | "sounds";
  setProjectsPageMode: (v: "projects" | "teams" | "designs" | "algorithms" | "sounds") => void;
  // Glance drill target (#…): the project whose fleet graph is open on the Glance Network page, or null
  // for the project network. Lifted into the store (transient, not persisted) so the app-wide navigation
  // history (mouse back/forward) can drive it alongside the active workspace. See useNavHistory.
  glanceDrill: string | null;
  setGlanceDrill: (id: string | null) => void;
  // Verify-preview (#2623, transient): the PreviewSource the verify-build produced per project (what the
  // graph's preview node renders), and whether a build is in flight. Not persisted — a served preview
  // URL dies with its process, so it's re-built on demand.
  previewSources: Record<string, PreviewSource>;
  setPreviewSource: (key: string, source: PreviewSource) => void;
  previewBuilding: Record<string, boolean>;
  setPreviewBuilding: (key: string, building: boolean) => void;
  // Preview REVIEW findings (#2623 slice 5b, transient): what the reviewer (Claude) flagged about the
  // running preview, per project key, in the confirm-gated inbox (pending → user confirms/dismisses;
  // confirmed ones route to the fleet, 5d). Not persisted — findings belong to a live preview session.
  reviewFindings: Record<string, ReviewFinding[]>;
  setReviewFindings: (key: string, findings: ReviewFinding[]) => void;
  // Teams drill target (#2492): the pool nodeId whose sub-graph is open in the Teams designer, or null for
  // the parent graph. Transient like glanceDrill and lifted into the store for the same reason — the
  // app-wide navigation history (mouse back/forward) steps drill in/out. See useNavHistory.
  teamsDrill: string | null;
  setTeamsDrill: (id: string | null) => void;
  // Inter-app contracts (#2253 → #3786 Phase 2) — the edges of the Glance L0 network. A write-through
  // cache over the global `bsc project link` store (agent-reachable): `addProjectLink` (idempotent,
  // deterministic id) + `removeProjectLink` push through the bridge; `hydrateProjectLinks` loads
  // authoritative on boot; the persisted copy is a fast-first-paint fallback. `target` (#3786) names a
  // NON-project endpoint (an external service / mcp server); absent ⇒ a project↔project contract.
  projectLinks: ProjectLink[];
  addProjectLink: (from: string, to: string, kind: GEdgeKind, target?: ContractTarget) => void;
  removeProjectLink: (id: string) => void;
  /** Hydrate the links from the global `bsc project link` store on boot (write-through cache). No-op when
   *  the bridge is unreachable (keeps the persisted cache). */
  hydrateProjectLinks: () => Promise<void>;
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
  // name-derived slug, plus any legacy forms — the raw title and the GitHub node id —
  // so grandfathered entries drop too, #2409), plus the active-project meta if it
  // matches. Pairs with the backend delete_project_dir for the on-disk hub.
  deleteLocalProject: (keys: string[]) => void;
  /** New, not-yet-published projects (drafts, #379). Keyed by the planning session key —
   *  the name-derived slug (`projectSlug(name)`, #2409) frozen at creation, or a legacy key
   *  (minted `p-…` id / title-sanitized) for grandfathered drafts. The record's `title` is
   *  display-only: renaming edits it in place (`updateDraftProject`) and never moves the
   *  on-disk hub (the folder keeps its birth-slug). */
  /** `role`/`health`/`activity` (#2284/#2541) are OPTIONAL Glance-node hints: when set they give the
   *  project's node its curated colour/state on the Glance network (`infra/service/data/client` ·
   *  health `idle/healthy/warning/error` · activity `building/waiting/review/…`), else
   *  `useGlanceProjects` derives them. Lets a project (or a loaded demo) declare its own colouring. */
  localDraftProjects: Record<string, { title: string; pitch: string; createdAt: number; role?: GRole; health?: GHealth; activity?: GActivity; reason?: string }>;
  addDraftProject: (key: string, draft: { title: string; pitch: string; createdAt: number; role?: GRole; health?: GHealth; activity?: GActivity; reason?: string }) => void;
  /** Patch a draft record in place (#1222) — persists a title edit so it survives a reopen;
   *  keyed by the FROZEN key so the on-disk folder doesn't move. No-ops if the draft is gone. */
  updateDraftProject: (key: string, patch: Partial<{ title: string; pitch: string }>) => void;
  removeDraftProject: (key: string) => void;
  /** TRIAGED projects (#2541): the durable set of projects whose triage/fleet has been launched — the
   *  drafted→triaged transition. Keyed by the plan key → the ms epoch it was first triaged. This is what
   *  gates the Glance network: a project appears there only once it's WORKING (`useGlanceProjects` filters
   *  to these keys), so a mere draft/plan never shows. Stamped by `triageStartProject`/`fleetStartProject`. */
  triagedProjects: Record<string, number>;
  /** Mark a project triaged (idempotent — keeps the first timestamp). */
  markProjectTriaged: (key: string) => void;
  /**
   * Move every per-project store entry from `oldKey` to `newKey` (#2409) — the store half of the
   * one-time hub relink (`relink_project_hub`) that migrates a legacy-keyed project onto its
   * name-derived slug. Covers the per-project data maps (plans, fleet, repos, drafts, toggles),
   * the repo-scoped (`<key>::<repo>`) prompt maps, and extension/skill scope lists. Target-wins:
   * an entry already present under `newKey` is never clobbered (the old one is dropped). Console
   * tab/pane state is NOT rewritten — a relinked project relaunches its fleet under the new key.
   */
  rekeyProjectData: (oldKey: string, newKey: string) => void;
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
  // can move the working directory out from under an active session. This is the
  // name-derived slug (`projectSlug(name)`, #2409) frozen at creation — renames are
  // display-only (the folder keeps its birth-slug); grandfathered projects pass
  // their legacy key (minted `p-…` id / title-sanitized) here unchanged.
  planningSessionKey: string;
  setPlanningSession: (key: string) => void;
  /** A prompt queued for the live planner session of a project, keyed by project key.
   *  Planning.tsx writes it into the planner PTY (a deliberate, user-triggered inject —
   *  e.g. the file-intake "Route" action) and clears it. (#604) */
  pendingPlannerPrompt: Record<string, string>;
  requestPlannerPrompt: (projectKey: string, text: string) => void;
  clearPlannerPrompt: (projectKey: string) => void;
  // Per-project AUTO-TRIAGE toggle (#2265). When ON, the fault-fix loop (useFaultTriage) routes a fix
  // for a new unresolved runtime fault (errordb, #2260) into the project's director via bsc-issue →
  // bsc-assign; when OFF (the default) faults are surfaced (the Glance node badge) but never
  // auto-dispatched. Keyed by the project's plan key (the same key the errordb/plan.db resolve under).
  autoTriage: Record<string, boolean>;
  /** Flip a project's auto-triage toggle (persisted). Default (absent) is OFF = surface-only. */
  setAutoTriage: (projectKey: string, on: boolean) => void;
  // Per-node Glance OFF toggle (#3239) — the user has DEACTIVATED this node from its details pane, so
  // it renders greyed (health `off`) on the network and reads "off" over any live status. Persisted so it
  // continues from the last session; keyed by the Glance node id (a project's plan key). Sparse map:
  // absent ⇒ the node is ON (its normal derived status). Cleaned on project delete/rename.
  glanceOff: Record<string, boolean>;
  /** Turn a Glance node off (deactivate, greyed) or back on (persisted). Default (absent) is ON. */
  setGlanceNodeOff: (nodeId: string, off: boolean) => void;
  // Per-project KIT AUTO-DISPATCH toggle (#2277). When ON, the kit-change drain (useKitDispatch) delivers
  // a BREAKING kit change queued for this consumer to a rail — a live fleet → its director via bsc-issue →
  // bsc-assign; no live fleet → a plain kit-update GitHub issue in the consumer repo. When OFF (the
  // default) queued changes are surface-only (KitChangesCard). Keyed by the consumer project's plan key.
  autoKitDispatch: Record<string, boolean>;
  /** Flip a project's kit auto-dispatch toggle (persisted). Default (absent) is OFF = notify-only. */
  setAutoKitDispatch: (projectKey: string, on: boolean) => void;
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
  // `clonePaths` (#1819): optional per-repo (fullName → absolute clone dir) cwds resolved from the
  // Rust backend (`repo_dir_path`), mirroring `fleetStartProject`'s `paths`. Used verbatim so a
  // triage launch never depends on the async-loaded `bscBaseDir` mirror (empty at crash-recovery
  // startup → empty cwd → the settings.json writer is skipped → a permission-less session); falls
  // back to the `bscBaseDir`-derived path per repo when an entry is absent.
  triageStartProject: (projectName: string, repos: string[], projectId?: string, deltas?: Record<string, string>, clonePaths?: Record<string, string>) => void;
  // #1004: read each repo's last-triage marker + the since-then changed-issue delta from plan.db,
  // render a one-line resume lead per repo, and STAMP a fresh run marker (read-before-write). Keyed
  // by the project's plan.db key (effectiveProjectId). Returns the fullName → lead map for `deltas`.
  prepareTriageRun: (projectKey: string, repos: string[]) => Promise<Record<string, string>>;
  // Index of this project's triage tab, matched on its STABLE projectKey — the
  // name-derived key (#457/#2409), not the derived "· triage" name — so a rename never
  // forks a duplicate. Pass the same projectName used to launch it. -1 when none.
  findTriageTabIdx: (projectName: string) => number;
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
    paths?: { hubPath?: string; worktreePaths?: Record<string, string>;
      /** When set (#1988), the fleet spawns INSIDE this WSL2 distro: hubPath/worktreePaths are
       *  distro-native paths and each pane records `paneWslDistro` so pty_create runs in the cage. */
      wslDistro?: string },
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
