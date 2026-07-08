// Glance fleet drill (#…) — the L1 graph you get by clicking a project on the L0 project network: that
// project's FLEET as a graph in the same Glance node/edge language (director + workers + a reviewer,
// wired by coordination edges), so the drill reads as one recursive graph zooming in. The topology is a
// deterministic SAMPLE per project until a real per-project fleet-plan feed lands (mirrors glanceData's
// sample project topology) — isolated here so wiring the real fleet later is a drop-in.
import type { GRawNode, GRawEdge, GRole, GEdgeKind, GNodeComm } from "./glanceGraph";
import type { GlanceData, ProjectLite } from "./glanceData";
import { hashAbs } from "./hash";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Persona } from "@/features/personas";
import { positionComms, type Org, type Position, type Relationship } from "@/features/org";

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

/**
 * Project a {@link FleetPlan} into a real {@link Org} (#2563) — the "fleet as Org" bridge. Streams (+ an
 * enabled director) become POSITIONS (personas referenced by id); coordination becomes RELATIONSHIPS
 * tagged with their archetype, in ARCHETYPE-NATIVE direction: the director MANAGES each stream, a typed
 * edge maps its kind (producer→consumer), a plain `dependsOn` is a lateral peer seam. Reusing the Org
 * model lets the drill derive each agent's communication surface (`positionComms`) from ONE source of
 * truth — the foundation for later authoring the fleet as an Org. Pure + exported for testing.
 */
export function fleetToOrg(fleet: FleetPlan): Org {
  const positions: Position[] = fleet.streams.map((s) => ({ nodeId: s.id, kind: "agent", personaId: s.persona, label: s.name || s.id }));
  if (fleet.director?.enabled) positions.push({ nodeId: "director", kind: "agent", personaId: "director", label: "director" });
  const posIds = new Set(positions.map((p) => p.nodeId));
  const relationships: Relationship[] = [];
  const seen = new Set<string>();
  const rel = (from: string, to: string, archetype: string) => {
    if (from === to || !posIds.has(from) || !posIds.has(to)) return;
    const k = `${from}|${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    relationships.push({ id: `r${relationships.length}`, archetype, from, to });
  };
  if (fleet.director?.enabled) for (const s of fleet.streams) rel("director", s.id, "manages"); // manager → report
  for (const e of fleet.edges ?? []) rel(e.from, e.to, KIND_TO_ARCHETYPE[e.kind] ?? "peers");   // producer → consumer
  for (const s of fleet.streams) for (const dep of s.dependsOn) rel(dep, s.id, "peers");         // upstream ↔ dependent
  return { id: "fleet", name: "Fleet", positions, relationships };
}

/** A minimal persona for a node with no matching persona entry (e.g. the director hub) — so its comms
 *  surface still renders. */
const fallbackPersona = (name: string, role: string): NonNullable<GRawNode["persona"]> => ({ name, role, skills: [], responsibilities: [] });

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
    rawNodes.push({ id: "director", slug: "director", role: "infra", roleLabel: "director", health: "idle", activity: "idle", persona: nodePersona(personaById.get("director")) ?? fallbackPersona("director", "director") });
    ids.add("director");
    for (const s of fleet.streams) add(s.id, "director", "api", "manages");
  }
  // typed relationship edges — producer→consumer becomes consumer-depends-on-producer
  for (const e of fleet.edges ?? []) add(e.to, e.from, KIND_TO_GKIND[e.kind] ?? "api", KIND_TO_ARCHETYPE[e.kind] ?? "peers");
  // plain dependsOn sequencing — a lateral peer seam
  for (const s of fleet.streams) for (const dep of s.dependsOn) add(s.id, dep, "api", "peers");

  // Communication surface (#2563): project the fleet into an Org and derive each agent's "who I talk to
  // and how" (`positionComms`) — the forms sent/received per relationship — attaching it to the node's
  // persona for the inspector. The Glance EDGES above are untouched; the org drives the comms only.
  const org = fleetToOrg(fleet);
  for (const n of rawNodes) {
    if (!n.persona) continue;
    const pos = org.positions.find((p) => p.nodeId === n.id);
    n.persona.comms = pos ? projectComms(org, pos, personas) : [];
  }

  return { rawNodes, rawEdges, sample: false };
}

/** Pare an org {@link positionComms} summary down to the glance node's {@link GNodeComm} shape (labels +
 *  transports only) — keeping the glance model decoupled from the Org form types. */
function projectComms(org: Org, pos: Position, personas: Persona[]): GNodeComm[] {
  return positionComms(org, pos, personas).map((c) => ({
    withName: c.counterpartName,
    archetypeLabel: c.archetypeLabel,
    hue: c.hue,
    sends: c.sends.map((f) => ({ label: f.label, transport: f.transport })),
    receives: c.receives.map((f) => ({ label: f.label, transport: f.transport })),
  }));
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
