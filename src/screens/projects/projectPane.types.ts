// projectPane.types -- the shared render-shape contract for the planning right
// pane (ProjectPane v2, #356). One source of truth for the data shapes the pane
// renders, so the section sub-issues (#337/#341/#343/#352/#349/...) build on the
// same types instead of redefining them. Pure type module (no React / Tauri),
// imported by both ProjectPane.tsx (the view) and projectPaneData.ts (the adapter
// that maps the real plan store into these shapes); projectPaneData re-exports
// them for back-compat with existing import sites.

import type { DirectorDrive } from "./directorDrive";
import type { IntegrationStrategy } from "./integrationStrategy";
import type { PlanGrade } from "../../lib/planGrade";
import type { PlanFeature } from "./featureList";
import type { SeamGraph } from "../../lib/planSeamGraph";
import type { Blueprint } from "./blueprints";

export type { PlanGrade };

export type Posture = "allow" | "ask" | "deny";
export type Perm = Record<string, Posture>;
export interface Flow { autonomy: string; push: string; gate: string }

/** An MCP server as the planning page's MCP pane renders it (#878) — the project's MCP
 *  extensions joined with catalog metadata and on-disk install state. A project-scoped
 *  enabled server reaches the whole fleet (director + every worker) via the launch wiring,
 *  so `scope` describes that reach and `agents` lists the fleet ids it's granted to. */
export interface McpServer {
  /** Extension id (stable key for toggle/build/remove). */
  id: string;
  name: string;
  transport: "stdio" | "http";
  /** The launch command (stdio: `command args`) or remote URL (http). */
  cmd: string;
  /** One-line description from the catalog, or "" for a custom server. */
  desc: string;
  enabled: boolean;
  /** Built by the @modelcontextprotocol org (vs. a first-party or custom server). */
  official: boolean;
  /** A downloadable first-party server (installs from source); drives download/build. */
  downloadable: boolean;
  /** Resolved install lifecycle for a downloadable server (else "n/a"):
   *  not-downloaded → "available", downloaded-not-built → "downloaded",
   *  built → "ready", a failed build → "error". A remote/built-in server is "ready". */
  status: "available" | "downloaded" | "ready" | "error" | "building" | "downloading";
  /** Human scope label: "fleet" (director + all workers) or "—" when not yet wired. */
  scope: string;
  /** Fleet agent ids this server is granted to (the whole fleet for a project server). */
  agents: string[];
  /** Tools the server exposes, if known (discovered at launch; usually empty pre-run). */
  tools: string[];
  /** Why the build failed, when `status === "error"`. */
  err?: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
  repo: string;
  color: string;
  initial: string;
  owns: string[];
  issues: string[];
  focus?: boolean;
  preset: string;
  perm: Perm;
  flow: Flow;
  /** Per-stream integration-strategy override (#378); undefined ⇒ inherits the fleet default. */
  strategy?: IntegrationStrategy;
  ctx: number;
}

export interface RepoBranch { n: string; issue: number; state: string; ahead: number; behind: number }
export interface Repo {
  id: string;
  branch: string;
  ahead: number;
  behind: number;
  agents: string[];
  primary: boolean;
  branches: RepoBranch[];
  /** Whether the repo has been cloned into the project hub (from the clone state). */
  cloned?: boolean;
  /** GitHub repo metadata, when known (absent during planning). */
  lang?: string;
  desc?: string;
}

export interface SubItem { t: string; done: boolean }
export interface Issue {
  n: number | string;
  t: string;
  state: string;
  owner: string;
  ac: number;
  branch: string;
  deps: (number | string)[];
  sub: SubItem[];
  /** Owning repo (`owner/name`). Carried so the phase-first view can group a
   *  phase's issues by repo. Optional for back-compat with the repo-first shape. */
  repo?: string;
}
export interface Epic { id: string; title: string; pct: number; issues: Issue[] }
export interface Milestone { id: string; title: string; repo: string; pct: number; state: string; epics: Epic[] }

/** A phase as a PROJECT-SCOPED milestone (#497): one phase spanning every repo,
 *  with its issues (each tagged with its repo) and a single progress rollup. */
export interface PhaseGroup {
  /** Stable-ish id (slug of the name); the persisted stable id lands in slice 2. */
  id: string;
  name: string;
  /** The phase's "done when" (its description), if any. */
  doneWhen?: string;
  /** 0-based order in the roadmap; the trailing Unscheduled group sorts last. */
  order: number;
  /** Issues in this phase across ALL repos, each carrying `repo`. */
  issues: Issue[];
  closed: number;
  total: number;
  pct: number;
}

export interface ContextFile { name: string; kind: string; tok: string; pinned: boolean; scope: string; content: string }

export interface PaneAutomation { name: string; command: string; schedule?: string }
export interface PaneSkill { name: string; kind: "skill" | "kb"; desc?: string }

export interface ProjectPaneData {
  agents: Agent[];
  repos: Repo[];
  /** Repo-first structure (repo → milestone → epic → issue); the secondary lens. */
  structure: Milestone[];
  /** Phase-first structure (#497): project-scoped phases, the primary lens. */
  phaseStructure: PhaseGroup[];
  context: ContextFile[];
  /** The async-integrator director config (#366), surfaced for the planning UI. */
  director: { enabled: boolean; role?: string; drive: DirectorDrive };
  /** Project-default integration strategy (#378); undefined ⇒ DEFAULT_STRATEGY. */
  fleetStrategy?: IntegrationStrategy;
  /** Cron automations the planner has proposed for this project (#674). */
  automations?: PaneAutomation[];
  /** Reusable skills/knowledge attached to the project's blueprint (#674). */
  skills?: PaneSkill[];
  /** MCP servers configured for this project (#878) — rendered in the MCP stage. */
  mcpServers?: McpServer[];
  /** User-facing capabilities defined in the Features stage (#…); each is a fleet stream. */
  features?: PlanFeature[];
  /** The in-progress blueprint an AUTHORING project is designing (#923) — rendered in the
   *  authoring stages' focused bodies (Purpose/Stages/Capabilities/Review). */
  authoredBlueprint?: Blueprint;
  /** The feature seam/dependency DAG (#…) — the Plan stage's approval surface. */
  seamGraph?: SeamGraph;
  // The agent-readiness grade (#445) is no longer carried on the pane data: it is now
  // produced by the grade-plan pipeline and read from the store (sectionGrades, as the
  // structure "agent-readiness" grader's detail) by the pane directly. PlanGrade is
  // still re-exported here for the report component's types.
}
