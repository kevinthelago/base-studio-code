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

/** Session-role → Glance colour bucket, grouped by agent FUNCTION (#2561): ORCHESTRATE (planner ·
 *  director) = infra, BUILD (worker) = service, VERIFY (reviewer · tester · juror) = data, FLOW (issuer ·
 *  triage · documentor · designer — intake, routing, docs, UI) = client. The bucket drives the colour;
 *  the real session role rides as `roleLabel` + the legend reads the function-group names at L1. */
const ROLE_TO_GROLE: Record<string, GRole> = {
  planner: "infra", director: "infra",
  worker: "service",
  reviewer: "data", tester: "data", juror: "data",
  issuer: "client", triage: "client", documentor: "client", designer: "client",
};
const gRole = (role?: string): GRole => (role && ROLE_TO_GROLE[role]) || "service";

/** Fleet coordination edge kind → Glance edge kind (contract "surface"). Kept for the hard/soft +
 *  colour-fallback; the ARCHETYPE (below) is what the drill actually labels + colours the edge by. */
const KIND_TO_GKIND: Record<string, GEdgeKind> = {
  handoff: "api", blocking: "data", sequence: "api", review: "data", notify: "events", shared: "events", mutex: "data",
};

/** Fleet coordination kind → Org relationship ARCHETYPE (#2561, interim map until fleets are authored as
 *  Orgs). The archetype names the relationship (Oversees a review, Stewards a shared resource, Peers on a
 *  handoff) and expands into the communication forms shown in the edge inspector. The director hub is a
 *  `manages` relationship; plain `dependsOn` is a lateral `peers` seam. */
const KIND_TO_ARCHETYPE: Record<string, string> = {
  handoff: "peers", blocking: "peers", sequence: "peers", review: "oversees", notify: "peers", shared: "peers", mutex: "stewards",
};

/** Resolve the persona surfaced on a fleet node (#2561): who is at this terminal. */
function nodePersona(p: Persona | undefined): GRawNode["persona"] {
  return p ? { name: p.name, role: p.role, model: p.model, skills: p.skills ?? [], responsibilities: p.responsibilities ?? [] } : undefined;
}

/** Build a project's REAL fleet as a Glance graph from its {@link FleetPlan}: streams → nodes (role +
 *  persona via their persona id), an optional director hub, and the typed coordination edges + plain
 *  `dependsOn` → the dependency edges, each tagged with its Org relationship archetype (#2561). Direction:
 *  a fleet edge runs producer→consumer, so the CONSUMER depends on the producer (the Glance "from depends
 *  on to" convention). Returns `sample:false`. */
export function buildRealFleetData(fleet: FleetPlan, personas: Persona[]): GlanceData {
  const personaById = new Map(personas.map((p) => [p.id, p]));
  const rawNodes: GRawNode[] = fleet.streams.map((s) => {
    // Each stream is a unique node; its ROLE + persona come from its persona id (default worker when
    // unset/unknown). The `role` category drives colour; `roleLabel` + `persona` ride for the card/inspector.
    const persona = s.persona ? personaById.get(s.persona) : undefined;
    const streamRole = persona?.role ?? "worker";
    // Rests at idle (#2551) — a planned stream isn't "building" until its session is actually live.
    return { id: s.id, slug: s.name || s.id, role: gRole(streamRole), roleLabel: streamRole, health: "idle" as const, activity: "idle" as const, persona: nodePersona(persona) };
  });
  const ids = new Set(rawNodes.map((n) => n.id));
  const rawEdges: GRawEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: GEdgeKind, archetype: string) => {
    if (from === to || !ids.has(from) || !ids.has(to)) return;
    const k = `${from}|${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    rawEdges.push({ from, to, kind, archetype });
  };

  // director hub — every stream is MANAGED by the director (drawn as the foundational node)
  if (fleet.director?.enabled && !ids.has("director")) {
    rawNodes.push({ id: "director", slug: "director", role: "infra", roleLabel: "director", health: "idle", activity: "idle", persona: nodePersona(personaById.get("director")) });
    ids.add("director");
    for (const s of fleet.streams) add(s.id, "director", "api", "manages");
  }
  // typed relationship edges — producer→consumer becomes consumer-depends-on-producer
  for (const e of fleet.edges ?? []) add(e.to, e.from, KIND_TO_GKIND[e.kind] ?? "api", KIND_TO_ARCHETYPE[e.kind] ?? "peers");
  // plain dependsOn sequencing — a lateral peer seam
  for (const s of fleet.streams) for (const dep of s.dependsOn) add(s.id, dep, "api", "peers");

  return { rawNodes, rawEdges, sample: false };
}

/**
 * Whether a fleet node has a LIVE terminal to open — the check that decides if clicking it morphs the
 * node into its in-graph terminal (#2534). A node is openable iff its identity pane id
 * (`<project>:<stream>` or `<project>:director`) is a live CELL of a launched fleet tab — the durable,
 * symmetric truth for BOTH workers and the DIRECTOR (#2542). Both are cells in the build tab, so both
 * open. This replaced the earlier per-pane runtime signals (roster / paneStatus / paneClaudeActive),
 * which covered workers but never the director: it isn't a stream (off the roster) and sits at "idle"
 * between prompts, so no transient runtime signal was true at click time. `livePaneIds` is the set of
 * pane ids that are cells of an open tab, minus ended/disabled panes. Pure.
 */
export function nodeHasLiveSession(paneId: string, livePaneIds: ReadonlySet<string>): boolean {
  return livePaneIds.has(paneId);
}

/** Build a project's fleet as a Glance graph: a director (infra hub), 2–4 workers (service), and a
 *  reviewer (data). Edges are "depends on": each worker depends on the director's direction (api), the
 *  reviewer reads each worker's output (data) — so the layout flows director → workers → reviewer. All
 *  clearly `sample` until a real fleet feed replaces it. */
export function buildFleetData(project: ProjectLite): GlanceData {
  const workers = 2 + (hashAbs(project.id) % 3); // 2..4
  const rawNodes: GRawNode[] = [
    { id: "director", slug: "director", role: "infra", roleLabel: "director", health: "healthy", activity: "building" },
    { id: "reviewer", slug: "reviewer", role: "data", roleLabel: "reviewer", health: "idle", activity: "review" },
  ];
  const rawEdges: GRawEdge[] = [];
  for (let i = 1; i <= workers; i++) {
    const id = `worker-${i}`;
    rawNodes.push({ id, slug: `worker ${i}`, role: "service", roleLabel: "worker", health: hashAbs(id + project.id) % 2 ? "healthy" : "idle", activity: "building" });
    rawEdges.push({ from: id, to: "director", kind: "api", archetype: "manages" });   // the director manages the worker
    rawEdges.push({ from: "reviewer", to: id, kind: "data", archetype: "oversees" }); // the reviewer oversees the worker's output
  }
  return { rawNodes, rawEdges, sample: true };
}
