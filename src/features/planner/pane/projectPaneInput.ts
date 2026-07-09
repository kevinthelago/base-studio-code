// projectPaneInput -- the input contract for the ProjectPane data adapter. Lives
// in its own module so the per-domain mapping helpers (projectPaneAgents/Repos/
// Structure/Context/Relationships) and the thin projectPaneData composition can
// all share it without a circular import back through projectPaneData.

import type { AgentProfile } from "@/features/security";
import type { FleetPlan } from "../fleet/planFleet";
import type { PlanIssue } from "../issues/planIssues";
import type { Section } from "../github/ghStructure";
import type { NodeProgress } from "../github/ghProgress";
import type { PaneAutomation, PaneSkill } from "./projectPane.types";
import type { PlanFeature } from "../issues/featureList";
import type { Blueprint } from "../stages/blueprints";
import type { DeployConfig } from "../lib/deployConfig";
import type { PlanDependency, DependencyRegistry } from "../issues/dependencies";
import type { McpInstallState } from "../lib/mcpPaneData";
import type { McpServer as McpServerDef } from "@/features/mcp";

export interface BuildProjectPaneInput {
  fleet?: FleetPlan;
  profiles: AgentProfile[];
  /** The persona library (#2094) — resolves a stream's `persona` reference to its role/kickoff/model
   *  for the agent projection (the row's role + kickoff preview). */
  personas?: import("@/features/personas").Persona[];
  issues: PlanIssue[];
  repos: string[];
  /** Full_names cloned into the project hub (clone state) — drives each repo's `cloned`. */
  clonedNames?: string[];
  /** Cron automations proposed for the project (#674). */
  automations?: PaneAutomation[];
  /** Skills/knowledge attached to the project's blueprint, pre-resolved (#674). */
  skills?: PaneSkill[];
  /** The full MCP-servers store + the project key, to build the MCP pane (#878). */
  mcpServers?: McpServerDef[];
  projectKey?: string;
  /** Per-server install lifecycle (probe + build button), keyed by extension id (#878). */
  mcpInstallState?: McpInstallState;
  /** Features defined in the Features stage (parsed from features.json) (#…). */
  features?: PlanFeature[];
  /** The in-progress blueprint an authoring project is designing (#923) — passed through to the
   *  pane so the authoring stages can render it. */
  authoredBlueprint?: Blueprint;
  /** Per-project coordination-topology override (#…) — set in the Permissions pane,
   *  wins over the planner's `fleet.json` topology. */
  topologyOverride?: import("../relationship/relationshipGraph").Topology;
  /** Per-project director-drive override (#…) — set in the Permissions pane, wins over
   *  `fleet.json`'s `director.drive`. */
  directorDriveOverride?: import("../fleet/directorDrive").DirectorDrive;
  /** The project's deployment & infrastructure config (#919) — the Deploy stage pane's state. */
  deployConfig?: DeployConfig;
  /** The locked dependency manifest (#1127/#1133) — surfaced in the Deploy pane. */
  dependencies?: PlanDependency[];
  registries?: Record<string, DependencyRegistry>;
  /** The project's {kit, theme} pairing (#2489) — inlined into each agent card's scope preview as
   *  the UI-palette lock block, matching what the launch path builds. */
  uiPairing?: import("../fleet/workerScope").WorkerUiPairing;
  sections: Section[];
  /** Context-file names the project has explicitly pinned in the pane (from the
   *  store). When present it drives each context file's `pinned` instead of the
   *  confirmed-section default. */
  pinned?: string[];
  /** Live GitHub issue-progression overlay (#393 Layer 2), keyed by structure node
   *  id (`issue:{repo}:{ref}`). When present it drives each issue's done-state and
   *  the milestone/epic percentages — reflecting what is actually CLOSED on GitHub
   *  — falling back to the static done/closed label when a node has no live data
   *  (#429). The same overlay the GitHubStructureCard renders, built by
   *  {@link buildProgressOverlay}. */
  progress?: Record<string, NodeProgress>;
}
