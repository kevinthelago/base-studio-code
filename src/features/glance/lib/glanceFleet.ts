// Glance fleet drill (#…) — the L1 graph you get by clicking a project on the L0 project network: that
// project's FLEET as a graph in the same Glance node/edge language (director + workers + a reviewer,
// wired by coordination edges), so the drill reads as one recursive graph zooming in. The topology is a
// deterministic SAMPLE per project until a real per-project fleet-plan feed lands (mirrors glanceData's
// sample project topology) — isolated here so wiring the real fleet later is a drop-in.
import type { GRawNode, GRawEdge, GRole, GEdgeKind } from "./glanceGraph";
import type { GlanceData, ProjectLite } from "./glanceData";
import { hashAbs } from "./hash";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Persona } from "@/features/personas";

/** Session-role → Glance node-role palette: the director/planner are the infra hub, workers are
 *  services, the quality roles (reviewer/tester/juror) are data, intake roles are clients. */
const ROLE_TO_GROLE: Record<string, GRole> = {
  director: "infra", planner: "infra",
  worker: "service",
  reviewer: "data", tester: "data", juror: "data",
  issuer: "client", triage: "client",
};
const gRole = (role?: string): GRole => (role && ROLE_TO_GROLE[role]) || "service";

/** Fleet coordination edge kind → Glance edge kind (contract "surface"). */
const KIND_TO_GKIND: Record<string, GEdgeKind> = {
  handoff: "api", blocking: "data", sequence: "api", review: "data", notify: "events", shared: "events", mutex: "data",
};

/** Build a project's REAL fleet as a Glance graph from its {@link FleetPlan}: streams → nodes (role via
 *  their persona), an optional director hub, and the typed coordination edges + plain `dependsOn` → the
 *  dependency edges. Direction: a fleet edge runs producer→consumer, so the CONSUMER depends on the
 *  producer (the Glance "from depends on to" convention). Returns `sample:false`. */
export function buildRealFleetData(fleet: FleetPlan, personas: Persona[]): GlanceData {
  const roleOf = new Map(personas.map((p) => [p.id, p.role]));
  const rawNodes: GRawNode[] = fleet.streams.map((s) => {
    // Each stream is a unique node; its ROLE comes from its persona (default worker when unset/unknown),
    // and both the mapped colour category and the real role label ride on the node.
    const streamRole = (s.persona ? roleOf.get(s.persona) : undefined) ?? "worker";
    return { id: s.id, slug: s.name || s.id, role: gRole(streamRole), roleLabel: streamRole, status: "planning" };
  });
  const ids = new Set(rawNodes.map((n) => n.id));
  const rawEdges: GRawEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: GEdgeKind) => {
    if (from === to || !ids.has(from) || !ids.has(to)) return;
    const k = `${from}|${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    rawEdges.push({ from, to, kind });
  };

  // director hub — every stream depends on its direction (drawn as the foundational node)
  if (fleet.director?.enabled && !ids.has("director")) {
    rawNodes.push({ id: "director", slug: "director", role: "infra", roleLabel: "director", status: "building" });
    ids.add("director");
    for (const s of fleet.streams) add(s.id, "director", "api");
  }
  // typed relationship edges — producer→consumer becomes consumer-depends-on-producer
  for (const e of fleet.edges ?? []) add(e.to, e.from, KIND_TO_GKIND[e.kind] ?? "api");
  // plain dependsOn sequencing
  for (const s of fleet.streams) for (const dep of s.dependsOn) add(s.id, dep, "api");

  return { rawNodes, rawEdges, sample: false };
}

/**
 * Whether a fleet node has a LIVE terminal session — the check that decides if clicking it morphs the
 * node into its in-graph terminal (#2534). EVERY node with a terminal gets the morph, so liveness is
 * the union of three signals:
 *   1. the launched `roster` (`fleetPaneStreams`) — workers, always true once launched;
 *   2. `claudeActive` (`paneClaudeActive`) — a live claude session, set true when claude starts and
 *      false when it exits, so it stays true ACROSS idle turns. This is what makes the DIRECTOR work
 *      (#2539): the director isn't a stream, so it's never in the roster, and it sits at "idle" between
 *      prompts — its transient `paneStatus` alone missed it exactly when the user clicked it;
 *   3. a live `paneStatus` ("run"/"on") — covers the brief window before claudeActive is set, and any
 *      non-claude session.
 * Pure — the workspace passes its live store maps in. (Absent from all three = no session.)
 */
export function nodeHasLiveSession(
  paneId: string,
  roster: Record<string, unknown>,
  paneStatus: Record<string, string | undefined>,
  claudeActive: Record<string, boolean> = {},
): boolean {
  if (roster[paneId]) return true;
  if (claudeActive[paneId]) return true;
  const st = paneStatus[paneId];
  return st === "run" || st === "on";
}

/** Build a project's fleet as a Glance graph: a director (infra hub), 2–4 workers (service), and a
 *  reviewer (data). Edges are "depends on": each worker depends on the director's direction (api), the
 *  reviewer reads each worker's output (data) — so the layout flows director → workers → reviewer. All
 *  clearly `sample` until a real fleet feed replaces it. */
export function buildFleetData(project: ProjectLite): GlanceData {
  const workers = 2 + (hashAbs(project.id) % 3); // 2..4
  const rawNodes: GRawNode[] = [
    { id: "director", slug: "director", role: "infra", roleLabel: "director", status: "building" },
    { id: "reviewer", slug: "reviewer", role: "data", roleLabel: "reviewer", status: "review" },
  ];
  const rawEdges: GRawEdge[] = [];
  for (let i = 1; i <= workers; i++) {
    const id = `worker-${i}`;
    rawNodes.push({ id, slug: `worker ${i}`, role: "service", roleLabel: "worker", status: hashAbs(id + project.id) % 2 ? "building" : "idle" });
    rawEdges.push({ from: id, to: "director", kind: "api" });   // worker takes direction from the director
    rawEdges.push({ from: "reviewer", to: id, kind: "data" });  // reviewer reads the worker's output
  }
  return { rawNodes, rawEdges, sample: true };
}
