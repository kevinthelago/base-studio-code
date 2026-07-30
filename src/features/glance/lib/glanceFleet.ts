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
import { archetypeById, positionComms, type Team, type Position, type Relationship } from "@/features/teams";
import type { BlueprintTeam } from "@/features/planner/stages/blueprintTypes";

/** Session-role → Glance colour bucket, grouped by agent FUNCTION (#2561): ORCHESTRATE (planner ·
 *  director) = infra, BUILD (worker) = service, VERIFY (reviewer · tester · juror) = data, FLOW (issuer ·
 *  triage · documentor · designer — intake, routing, docs, UI) = client. The bucket drives the colour;
 *  the real session role rides as `roleLabel` + the legend reads the function-group names at L1. */
const ROLE_TO_GROLE: Record<string, GRole> = {
  planner: "infra", director: "infra", debugger: "infra",
  worker: "service",
  reviewer: "data", tester: "data", juror: "data",
  issuer: "client", triage: "client", documentor: "client", designer: "client",
};
const gRole = (role?: string): GRole => (role && ROLE_TO_GROLE[role]) || "service";

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
export function fleetToOrg(fleet: FleetPlan, team?: BlueprintTeam): Team {
  const positions: Position[] = fleet.streams.map((s) => ({ nodeId: s.id, kind: "agent", personaId: s.persona, label: s.name || s.id }));
  if (fleet.director?.enabled) positions.push({ nodeId: "director", kind: "agent", personaId: "director", label: "director" });
  const posIds = new Set(positions.map((p) => p.nodeId));
  // Authored-team archetype overlay (#2572): a `persona→persona` pair the blueprint team wired with an
  // archetype OVERRIDES the coordination-derived archetype for that pair — so the authored design's
  // semantics drive the drill wherever the team authored them. Empty (no team) ⇒ pure derived, unchanged.
  const authored = teamArchetypeByPersonaPair(team);
  const personaOf = new Map<string, string | undefined>(fleet.streams.map((s) => [s.id, s.persona]));
  personaOf.set("director", "director");
  const archOf = (from: string, to: string, derived: string): string => {
    const pf = personaOf.get(from), pt = personaOf.get(to);
    return (pf && pt && authored.get(`${pf}|${pt}`)) || derived;
  };
  const relationships: Relationship[] = [];
  const seen = new Set<string>();
  const rel = (from: string, to: string, archetype: string) => {
    if (from === to || !posIds.has(from) || !posIds.has(to)) return;
    const k = `${from}|${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    relationships.push({ id: `r${relationships.length}`, archetype, from, to });
  };
  if (fleet.director?.enabled) for (const s of fleet.streams) rel("director", s.id, archOf("director", s.id, "manages")); // manager → report
  for (const e of fleet.edges ?? []) rel(e.from, e.to, archOf(e.from, e.to, KIND_TO_ARCHETYPE[e.kind] ?? "peers"));        // producer → consumer
  for (const s of fleet.streams) for (const dep of s.dependsOn) rel(dep, s.id, archOf(dep, s.id, "peers"));                // upstream ↔ dependent

  // Phase 2 (#2575): ADD the team's authored relationships that have no derived edge, INSTANTIATED onto
  // the streams by persona — a team rel posA→posB becomes every {posA-persona stream} × {posB-persona
  // stream} pair with the team's archetype. `rel` dedups vs the derived edges above (a pair with both
  // keeps its slice-3-overlaid archetype), so this only ADDS authored relationships the coordination
  // didn't wire. Nodes stay the fleet streams (identity + liveness preserved).
  if (team) {
    const streamsByPersona = new Map<string, string[]>();
    for (const s of fleet.streams) if (s.persona) {
      const arr = streamsByPersona.get(s.persona);
      if (arr) arr.push(s.id); else streamsByPersona.set(s.persona, [s.id]);
    }
    const personaOfPos = new Map(team.positions.map((p) => [p.nodeId, p.personaId]));
    for (const tr of team.relationships) {
      const pa = personaOfPos.get(tr.from), pb = personaOfPos.get(tr.to);
      if (!pa || !pb) continue;
      for (const sa of streamsByPersona.get(pa) ?? []) for (const sb of streamsByPersona.get(pb) ?? []) rel(sa, sb, tr.archetype);
    }
  }
  return { id: "fleet", name: "Fleet", positions, relationships };
}

/** A `personaFrom|personaTo → archetype` lookup from a blueprint {@link BlueprintTeam}'s authored
 *  relationships (#2572) — so the fleet projection can override a coordination pair's archetype with the
 *  team's authored one when the two streams' personas match (direction included). Empty for no team. */
function teamArchetypeByPersonaPair(team?: BlueprintTeam): Map<string, string> {
  const m = new Map<string, string>();
  if (!team) return m;
  const personaOf = new Map(team.positions.map((p) => [p.nodeId, p.personaId]));
  for (const r of team.relationships) {
    const pf = personaOf.get(r.from), pt = personaOf.get(r.to);
    if (pf && pt) m.set(`${pf}|${pt}`, r.archetype);
  }
  return m;
}

/** Convert a blueprint {@link BlueprintTeam} into a standalone {@link Org} (#2572) — the team is already
 *  `{positions, relationships}`, so this just stamps the library-identity fields. Exported for phase 2
 *  (rendering the drill from the authored team directly). */
export function teamToOrg(team: BlueprintTeam): Team {
  return { id: "team", name: "Team", positions: team.positions, relationships: team.relationships };
}

/** A minimal persona for a node with no matching persona entry (e.g. the director hub) — so its comms
 *  surface still renders. */
const fallbackPersona = (name: string, role: string): NonNullable<GRawNode["persona"]> => ({ name, role, skills: [], responsibilities: [] });

/** Org relationship archetype → a representative Glance edge `kind` (#2565). For a fleet-drill (L1) edge
 *  the `kind` is largely vestigial — the edge is coloured + labelled by its ARCHETYPE now (#2561), and
 *  `kind` drives only the `hard` flag (unshown at L1); the archetype is the real identity. */
const ARCHETYPE_TO_KIND: Record<string, GEdgeKind> = {
  manages: "api", oversees: "data", consults: "events", peers: "api", serves: "events", stewards: "data",
};

/**
 * Render a Glance fleet graph FROM an {@link Org} (#2565) — the ONE source that drives the drill's nodes,
 * edges, AND comms. Positions → nodes (persona resolved + its communication surface via `positionComms`);
 * relationships → edges. Direction: a Glance edge is "from depends on to" — the INVERSE of an org
 * relationship's archetype-native direction (a report depends on its manager, a consumer on its producer)
 * — so each relationship maps to a Glance edge REVERSED. Pure + exported: the org may be projected from a
 * running fleet (below) or, later, sourced from a blueprint's authored `team`.
 */
export function buildOrgFleetData(org: Team, personas: Persona[]): GlanceData {
  const personaById = new Map(personas.map((p) => [p.id, p]));
  const rawNodes: GRawNode[] = org.positions.map((pos) => {
    const persona = pos.personaId ? personaById.get(pos.personaId) : undefined;
    const role = persona?.role ?? (pos.nodeId === "director" ? "director" : "worker");
    const p = nodePersona(persona) ?? fallbackPersona(pos.label ?? persona?.name ?? pos.nodeId, role);
    p.comms = projectComms(org, pos, personas); // who this agent talks to + how (#2563)
    // Rests at idle (#2551) — a planned position isn't "building" until its session is actually live.
    // A `resource` position (a library, not an agent) is marked so the canvas draws it distinctly (#3322)
    // instead of the persona-less "worker" fallback role reading as an agent node.
    return { id: pos.nodeId, slug: pos.label ?? persona?.name ?? pos.nodeId, role: gRole(role), roleLabel: role, health: "off" as const, activity: "idle" as const, persona: p, resource: pos.kind === "resource" || undefined };
  });
  const ids = new Set(rawNodes.map((n) => n.id));
  const rawEdges: GRawEdge[] = [];
  const seen = new Set<string>();
  for (const r of org.relationships) {
    // A CYCLICAL archetype (iterates, #2578) is a deliberate feedback LOOP — emit BOTH directions so the
    // shared graph-core cycle primitive (`mutualPairs`) detects it and renders it as a bowed loop; every
    // other archetype maps to ONE reversed edge (Glance "from depends on to" inverts the org direction).
    const dirs: [string, string][] = archetypeById(r.archetype)?.cyclical
      ? [[r.to, r.from], [r.from, r.to]]
      : [[r.to, r.from]];
    for (const [from, to] of dirs) {
      if (from === to || !ids.has(from) || !ids.has(to)) continue;
      const k = `${from}|${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rawEdges.push({ from, to, kind: ARCHETYPE_TO_KIND[r.archetype] ?? "api", archetype: r.archetype });
    }
  }
  return { rawNodes, rawEdges, sample: false };
}

/** Build a project's REAL fleet as a Glance graph — project the {@link FleetPlan} into an Org (#2563) and
 *  render from it (#2565), so the drill's nodes / edges / comms all flow from ONE source (the Org). The
 *  layout is topology-identical to the pre-#2565 inline builder. Returns `sample:false`. */
export function buildRealFleetData(fleet: FleetPlan, personas: Persona[], team?: BlueprintTeam): GlanceData {
  return buildOrgFleetData(fleetToOrg(fleet, team), personas);
}

/** The fleet-drill's PREVIEW node id (#2623) — a reserved, non-agent node, so it never collides with a
 *  stream id (stream ids are slugs; this carries the structural `:` + reserved tail, like `:director`). */
export const PREVIEW_NODE_ID = "__preview__";

/**
 * Add the PREVIEW node to a fleet-drill graph when the project is COMPLETE (#2623) — the surface the user
 * clicks to render the finished application in the graph (it morphs open the app preview the way an agent
 * node morphs open its terminal). Not an agent: no persona/edges, marked `preview`, and rendered
 * distinctly by the canvas. Idempotent (never doubles) and a no-op while the project is still building, so
 * the node appears exactly when there's something to preview. Pure.
 */
export function withPreviewNode(data: GlanceData, complete: boolean): GlanceData {
  if (!complete || data.rawNodes.some((n) => n.preview)) return data;
  const preview: GRawNode = {
    id: PREVIEW_NODE_ID, slug: "preview", role: "client", roleLabel: "preview",
    health: "healthy", activity: "live", preview: true,
  };
  return { ...data, rawNodes: [...data.rawNodes, preview] };
}

/** Pare an org {@link positionComms} summary down to the glance node's {@link GNodeComm} shape (labels +
 *  transports only) — keeping the glance model decoupled from the Org form types. */
function projectComms(org: Team, pos: Position, personas: Persona[]): GNodeComm[] {
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

/**
 * Every live session pane that belongs to a project — its director + workers — so the whole fleet can be
 * ended at once (#3052). A fleet pane id is `<projectKey>:<streamId>` (fleetPaneId), so the project's
 * panes are exactly those with the `<projectKey>:` prefix. The trailing `:` makes the match EXACT: a
 * project keyed `cli` never captures `cli-typer`'s panes. Pure; the caller kills each returned pane.
 */
export function livePanesForProject(projectKey: string, livePaneIds: ReadonlySet<string>): string[] {
  if (!projectKey) return [];
  const prefix = `${projectKey}:`;
  return [...livePaneIds].filter((pid) => pid.startsWith(prefix));
}

/** Build a project's fleet as a Glance graph: a director (infra hub), 2–4 workers (service), a reviewer
 *  (data), and an auditor (data) in a CYCLICAL loop with the reviewer (#2578). Edges are "depends on":
 *  each worker depends on the director's direction (api), the reviewer oversees each worker's output
 *  (data), and the auditor ⟳ reviewer edge is a deliberate iteration loop (findings ⟳ revisions). All
 *  clearly `sample` until a real fleet feed replaces it. */
export function buildFleetData(project: ProjectLite): GlanceData {
  const workers = 2 + (hashAbs(project.id) % 3); // 2..4
  const rawNodes: GRawNode[] = [
    { id: "director", slug: "director", role: "infra", roleLabel: "director", health: "healthy", activity: "building" },
    { id: "reviewer", slug: "reviewer", role: "data", roleLabel: "reviewer", health: "off", activity: "review" },
    { id: "auditor", slug: "auditor", role: "data", roleLabel: "auditor", health: "off", activity: "review" },
  ];
  // The auditor ⟳ reviewer iteration loop (#2578): both directions so `mutualPairs` reads it as a cycle.
  const rawEdges: GRawEdge[] = [
    { from: "auditor", to: "reviewer", kind: "data", archetype: "iterates" },
    { from: "reviewer", to: "auditor", kind: "data", archetype: "iterates" },
  ];
  for (let i = 1; i <= workers; i++) {
    const id = `worker-${i}`;
    rawNodes.push({ id, slug: `worker ${i}`, role: "service", roleLabel: "worker", health: hashAbs(id + project.id) % 2 ? "healthy" : "off", activity: "building" });
    rawEdges.push({ from: id, to: "director", kind: "api", archetype: "manages" });   // the director manages the worker
    rawEdges.push({ from: "reviewer", to: id, kind: "data", archetype: "oversees" }); // the reviewer oversees the worker's output
  }
  return { rawNodes, rawEdges, sample: true };
}
