// projectPane.types -- the shared render-shape contract for the planning right
// pane (ProjectPane v2, #356). One source of truth for the data shapes the pane
// renders, so the section sub-issues (#337/#341/#343/#352/#349/...) build on the
// same types instead of redefining them. Pure type module (no React / Tauri),
// imported by both ProjectPane.tsx (the view) and projectPaneData.ts (the adapter
// that maps the real plan store into these shapes); projectPaneData re-exports
// them for back-compat with existing import sites.

import type { DirectorDrive } from "./directorDrive";
import type { IntegrationStrategy } from "./integrationStrategy";

export type Posture = "allow" | "ask" | "deny";
export type Perm = Record<string, Posture>;
export interface Flow { autonomy: string; push: string; gate: string }

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
}
export interface Epic { id: string; title: string; pct: number; issues: Issue[] }
export interface Milestone { id: string; title: string; repo: string; pct: number; state: string; epics: Epic[] }

export interface ContextFile { name: string; kind: string; tok: string; pinned: boolean; scope: string; content: string }

export interface ProjectPaneData {
  agents: Agent[];
  repos: Repo[];
  structure: Milestone[];
  context: ContextFile[];
  /** The async-integrator director config (#366), surfaced for the planning UI. */
  director: { enabled: boolean; role?: string; drive: DirectorDrive };
  /** Project-default integration strategy (#378); undefined ⇒ DEFAULT_STRATEGY. */
  fleetStrategy?: IntegrationStrategy;
}
