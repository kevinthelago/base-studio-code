// The synthetic "base-studio-code" default project (#3319) — the app's OWN app-owned studio sessions
// surfaced in the Glance graph. It is not a real planner project on disk: it's a fixed L0 node whose
// drilled-in graph is the STUDIO NETWORK team (`org-planning-studio`, completed in #3317), rendered
// through the existing Team→Glance adapter (`buildOrgFleetData`). The debugger node is gated by the
// Settings `debugSession` toggle via #3317's pure augmentation. Pure + React-free so it's unit-testable.
import { augmentStudioNetworkForDebug, STUDIO_NETWORK_ID, type Team } from "@/features/teams";
import type { Persona } from "@/features/personas";
import { DEBUG_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";
import { buildOrgFleetData } from "./glanceFleet";
import type { GlanceData, ProjectLite } from "./glanceData";

/** The synthetic project's id. Namespaced with a colon so it can NEVER collide with a real project slug
 *  (`projectSlug` is `[a-z0-9-]`, no colon). */
export const BASE_STUDIO_PROJECT_ID = "app:base-studio-code";

/** The base-studio-code default project's L0 node — always present in the Glance network (the app's own
 *  project), infra role + maintain lifecycle. Drilling it renders the studio sessions (see below). */
export const BASE_STUDIO_PROJECT: ProjectLite = {
  id: BASE_STUDIO_PROJECT_ID,
  name: "base-studio-code",
  role: "infra",
  category: "maintain",
  health: "idle",
  activity: "idle",
};

/**
 * The base-studio-code project's drilled graph — the Studio Network team's positions (the app-owned
 * studio sessions) as nodes and its relationships as edges, with the debugger node included IFF the
 * Settings debug toggle is on. Returns `null` when the team isn't present (so the caller falls back to
 * the empty/sample graph rather than crashing). Pure.
 */
export function buildStudioFleetData(teams: readonly Team[], personas: Persona[], debugOn: boolean): GlanceData | null {
  const team = teams.find((t) => t.id === STUDIO_NETWORK_ID);
  return team ? buildOrgFleetData(augmentStudioNetworkForDebug(team, debugOn), personas) : null;
}

/**
 * The app-owned session pane id for a base-studio-code studio graph node — the bridge that lets the
 * in-graph morph host that node's LIVE terminal (#3326), the studio analogue of `fleetPaneId`. Only the
 * DEBUGGER node is migrated onto the shared TerminalHost so far (kept warm by `DebugSessionMount`); the
 * designer/librarian/architect still run on their own single-mount `useScreenSession` surfaces, which the
 * morph can't re-parent — so they return null and a click just selects them until they're migrated too.
 * The `"debugger"` id is the Studio Network team's debugger position `nodeId` (`DEBUGGER_NODE` in
 * `features/teams/lib/team.ts`) — stable (it's also the persona role + graph node id). Returns null for a
 * non-studio node. Pure.
 */
export function studioPaneIdForNode(nodeId: string): string | null {
  return nodeId === "debugger" ? DEBUG_STUDIO_SESSION_ID : null;
}
