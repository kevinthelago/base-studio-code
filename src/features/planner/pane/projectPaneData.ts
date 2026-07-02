// projectPaneData -- maps the real plan store (fleet streams, agent profiles,
// decomposed issues, sections, linked repos) into the shapes the
// ProjectPane (v2) renders. Pure (no React / Tauri) so the mapping is unit-testable,
// keeping the pane a dumb view. ProjectPane re-imports these interfaces, so this
// module is the single source of truth for the pane data contract; the pane
// falls back to its own sample consts when a project has none of this yet.
//
// The per-domain mapping steps live in colocated sibling modules (#2151):
//   projectPaneAgents / projectPaneRepos / projectPaneStructure /
//   projectPaneContext / projectPaneRelationships. This file is the thin
//   composition that calls them and owns the public data contract.

import { resolveDirectorDrive } from "../fleet/directorDrive";
import { buildMcpServers } from "../lib/mcpPaneData";

// The render-shape contract lives in projectPane.types (#356, the shared pane
// types). This adapter re-exports those shapes so existing import sites that reach
// for them via "./projectPaneData" keep working.
import type { ProjectPaneData } from "./projectPane.types";
import type { BuildProjectPaneInput } from "./projectPaneInput";

import { buildAgents } from "./projectPaneAgents";
import { buildRepos } from "./projectPaneRepos";
import { buildStructure } from "./projectPaneStructure";
import { buildContext } from "./projectPaneContext";
import { effectiveStreams, deriveRelationships } from "./projectPaneRelationships";

export type { BuildProjectPaneInput } from "./projectPaneInput";
export type {
  Posture, Perm, Flow, Agent, RepoBranch, Repo, SubItem, Issue, Epic, Milestone,
  ContextFile, ProjectPaneData, PaneAutomation, PaneSkill, McpServer,
} from "./projectPane.types";

/**
 * Build the ProjectPane render data from the real plan store. Robust to missing
 * pieces: no fleet -> no agents and no repo->agent links; no issues -> empty
 * structure; no sections -> empty context. The pane treats an all-empty result as
 * a signal to fall back to its illustrative sample data.
 */
export function buildProjectPaneData(input: BuildProjectPaneInput): ProjectPaneData {
  return {
    agents: buildAgents(input),
    repos: buildRepos(input),
    structure: buildStructure(input),
    context: buildContext(input),
    director: {
      enabled: input.fleet?.director.enabled ?? false,
      role: input.fleet?.director.role,
      drive: resolveDirectorDrive(input.directorDriveOverride ?? input.fleet?.director.drive),
    },
    fleetStrategy: input.fleet?.strategy,
    automations: (input.automations ?? []).map(a => ({ name: a.name, command: a.command, schedule: a.schedule })),
    skills: input.skills ?? [],
    mcpServers: buildMcpServers(input.mcpServers ?? [], input.projectKey ?? "", input.fleet, input.mcpInstallState),
    features: input.features ?? [],
    authoredBlueprint: input.authoredBlueprint,
    deploy: input.deployConfig,
    dependencies: input.dependencies ?? [],
    registries: input.registries ?? {},
    // Coordination topology: the user's per-project override wins over the planner's
    // fleet.json default, falling back to hybrid (#…).
    topology: input.topologyOverride ?? input.fleet?.topology ?? "hybrid",
    relationshipArtifacts: input.fleet?.artifacts ?? [],
    // Use the planner's explicit typed edges when present; otherwise DERIVE them so the
    // graph shows for any planned fleet. The derivation aggregates the granular ISSUE
    // dependency tree (issues.json — the same data the seam graph uses) up to the stream
    // level, so the relationship graph has the same dependency depth (and thus phase
    // layers) as the seam graph, plus any explicit stream-level `dependsOn` (#…).
    relationships: input.fleet?.edges?.length
      ? input.fleet.edges
      : deriveRelationships(effectiveStreams(input), input.issues),
  };
}
