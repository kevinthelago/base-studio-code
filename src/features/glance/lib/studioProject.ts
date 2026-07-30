// The synthetic "base-studio-code" default project (#3319) — the app's OWN app-owned studio sessions
// surfaced in the Glance graph. It is not a real planner project on disk: it's a fixed L0 node whose
// drilled-in graph is the STUDIO NETWORK team (`org-planning-studio`, completed in #3317), rendered
// through the existing Team→Glance adapter (`buildOrgFleetData`). The debugger node is gated by the
// Settings `debugSession` toggle via #3317's pure augmentation. Pure + React-free so it's unit-testable.
import { augmentStudioNetworkForDebug, augmentStudioNetworkForRequests, STUDIO_NETWORK_ID, type Team } from "@/features/teams";
import { poolSlotFromNodeId, poolPaneId } from "@/shared/lib/session/requestSpawn";
import type { Persona } from "@/features/personas";
import {
  DEBUG_STUDIO_SESSION_ID, DESIGN_STUDIO_SESSION_ID,
  ALGORITHMS_STUDIO_SESSION_ID, TEAMS_STUDIO_SESSION_ID, SOUND_STUDIO_SESSION_ID,
  INTEGRATION_STUDIO_SESSION_ID,
} from "@/shared/lib/session/systemSessions";
import { buildOrgFleetData } from "./glanceFleet";
import type { GlanceData, ProjectLite } from "./glanceData";
import type { GHealth, GActivity, GRawNode } from "./glanceGraph";

/** The synthetic project's id. Namespaced with a colon so it can NEVER collide with a real project slug
 *  (`projectSlug` is `[a-z0-9-]`, no colon). */
export const BASE_STUDIO_PROJECT_ID = "app:base-studio-code";

/** The base-studio-code default project's L0 node — always present in the Glance network (the app's own
 *  project), infra role + maintain lifecycle. Drilling it renders the studio sessions (see below). */
export const BASE_STUDIO_PROJECT: ProjectLite = {
  id: BASE_STUDIO_PROJECT_ID,
  name: "base-studio-code",
  role: "infra",
  health: "off",
  activity: "idle",
};

/**
 * The base-studio-code project's drilled graph — the Studio Network team's positions (the app-owned
 * studio sessions) as nodes and its relationships as edges, with the debugger node included IFF the
 * Settings debug toggle is on. Returns `null` when the team isn't present (so the caller falls back to
 * the empty/sample graph rather than crashing). Pure.
 */
export function buildStudioFleetData(
  teams: readonly Team[],
  personas: Persona[],
  debugOn: boolean,
  /** #3535: live overflow-pool SLOT indices — each becomes its own openable node. */
  poolSlots: readonly number[] = [],
): GlanceData | null {
  const team = teams.find((t) => t.id === STUDIO_NETWORK_ID);
  if (!team) return null;
  const withDebug = augmentStudioNetworkForDebug(team, debugOn);
  return buildOrgFleetData(augmentStudioNetworkForRequests(withDebug, poolSlots), personas);
}

/**
 * The stable, app-owned session pane id for each base-studio-code studio graph node (#3319) — the studio
 * analogue of `fleetPaneId`. The node ids are the Studio Network team position ids
 * (`data/teams/orgs/planning-studio.json`), and each maps to its ONE app-owned session's fixed id
 * (`systemSessions.ts`). Because these ids are STABLE, opening a node re-uses the SAME session (its host
 * re-mounts it, `claude --continue`) rather than spawning a duplicate — the "reuse if it exists, create
 * if not" the studio sessions want. The `resource` nodes (libraries) and the dynamic `planner` session
 * have no fixed session, so they return null. Pure.
 */
const STUDIO_NODE_SESSION: Record<string, string> = {
  designer: DESIGN_STUDIO_SESSION_ID,
  librarian: ALGORITHMS_STUDIO_SESSION_ID,
  architect: TEAMS_STUDIO_SESSION_ID,
  "sound-designer": SOUND_STUDIO_SESSION_ID,
  integrator: INTEGRATION_STUDIO_SESSION_ID,
  debugger: DEBUG_STUDIO_SESSION_ID,
};
export function studioPaneIdForNode(nodeId: string): string | null {
  // #3535: an overflow-pool session is DYNAMIC — one node per live pool slot — so it cannot live in the
  // fixed map above. Without this branch such a node resolves to no pane, which means it cannot be
  // opened, cannot report live status, and is a session the user can neither watch nor stop.
  const slot = poolSlotFromNodeId(nodeId);
  if (slot !== null) return poolPaneId(slot);
  return STUDIO_NODE_SESSION[nodeId] ?? null;
}

/** Where a studio node's session is HOSTED, so the graph can open/reveal it (#glance-resume). Since #3357
 *  ALL FOUR app-owned studio sessions live on the shared TerminalHost — the debugger via
 *  `DebugSessionMount`, the designer/librarian/architect via `StudioSessionHosts` — so every one of them is
 *  openable INLINE via the Glance `morph`: the host re-parents the single live terminal into the morph and
 *  hands it back to the studio's page dock on close, never spawning a second session. (Before #3357 the
 *  three studios ran their own single-mount xterm, which could not be re-parented, so they had to open on
 *  their workspace page instead — the `page` variant, kept for a future non-morphable node.) Null for a
 *  node with no openable session (the libraries, the dynamic planner). Pure. */
export type StudioNodeHome =
  | { kind: "morph" }
  | { kind: "page"; pageMode: "designs" | "algorithms" | "teams" };
export function studioNodeHome(nodeId: string): StudioNodeHome | null {
  // #3535: an overflow-pool session opens exactly like the studios it is one of.
  if (poolSlotFromNodeId(nodeId) !== null) return { kind: "morph" };
  switch (nodeId) {
    case "debugger":
    case "designer":
    case "librarian":
    case "architect":
    case "sound-designer":
      return { kind: "morph" };
    default: return null;
  }
}

/**
 * Whether a base-studio-code studio node's session is currently ACTIVE (#glance-resume) — so the node
 * reflects a running session rather than a planned position. The DEBUGGER is live while the Settings
 * `debugSession` flag is on (its node only exists then anyway); the designer/librarian/architect are live
 * while their stable-id session is mounted + running (a live `paneClaudeActive` or a `run`/`on`
 * paneStatus). Pure so the liveness rule is unit-testable; the workspace passes the store signals.
 */
export function studioSessionLive(
  nodeId: string,
  signals: { debugSession: boolean; paneClaudeActive: Record<string, boolean>; paneStatus: Record<string, string | undefined> },
): boolean {
  const sid = studioPaneIdForNode(nodeId);
  if (!sid) return false;
  if (nodeId === "debugger") return signals.debugSession;
  return !!signals.paneClaudeActive[sid] || signals.paneStatus[sid] === "run" || signals.paneStatus[sid] === "on";
}

/** The store signals {@link applyStudioLiveStatus} reads — the same set {@link studioSessionLive} takes. */
export interface StudioLiveSignals {
  debugSession: boolean;
  paneClaudeActive: Record<string, boolean>;
  paneStatus: Record<string, string | undefined>;
}

/**
 * Overlay the LIVE session state onto the base-studio-code project's studio nodes (#3421) — the studio
 * twin of `applyFleetLiveStatus`, and it exists because the two key their nodes DIFFERENTLY.
 *
 * A fleet node's pane id is `fleetPaneId(projectKey, nodeId)` (`<project>:<stream>`); a studio node's is
 * its STABLE app-owned session id from {@link studioPaneIdForNode} (`DESIGN_STUDIO_SESSION_ID`, …). Running
 * the fleet overlay over studio nodes therefore looked up `base-studio-code:designer`, which never exists,
 * so no studio node was ever found live. That mis-keying was invisible while an unmatched node fell through
 * to the raw `idle/idle` default (a plausible resting state) — #3415 made an unlaunched node read `off`,
 * which pinned every studio node `off` no matter what its session was doing.
 *
 * Health follows the #3415 model — existence AND work, not mere launch:
 *
 *   - no session mounted                          → off · idle
 *   - mounted but quiet                           → idle · idle
 *   - mounted + working (`paneStatus === "run"`)  → healthy · building
 *
 * A node with NO fixed session (the `resource` libraries, the dynamic planner) is left untouched: it has no
 * runtime state of its own, so forcing it `off` would misreport a library as a dead session. Pure — apply to
 * `rawNodes` BEFORE `buildGraph` so the rollup recomputes over the live values.
 */
export function applyStudioLiveStatus(nodes: GRawNode[], signals: StudioLiveSignals): GRawNode[] {
  return nodes.map((n) => {
    if (n.preview) return n; // not a session node — its own state stands
    const sid = studioPaneIdForNode(n.id);
    if (!sid) return n; // a library/resource or the dynamic planner — no session to report on
    if (!studioSessionLive(n.id, signals)) {
      return { ...n, health: "off" as GHealth, activity: "idle" as GActivity };
    }
    return signals.paneStatus[sid] === "run"
      ? { ...n, health: "healthy" as GHealth, activity: "building" as GActivity }
      : { ...n, health: "off" as GHealth, activity: "idle" as GActivity };
  });
}
