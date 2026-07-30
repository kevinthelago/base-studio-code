// Glance data adapter (#2206) — bridges the app's REAL project list into the graph model. Nodes come
// from the user's projects; the TOPOLOGY (roles · edge kinds · dependencies · status) is clearly-marked
// SAMPLE until a real cross-project dependency model exists (epic #2205, slice 4). Isolated here so
// wiring real edges later is a drop-in — the page + graph core never change.
import sampleGraphEmbedded from "@data/glance/sample-graph.json";
import type { GRawNode, GRawEdge, GRole, GHealth, GActivity } from "./glanceGraph";
import { kitNodeId, usesKitEdgeId, libraryNodeId, requiresEdgeId, mcpNodeId, usesMcpEdgeId, serviceNodeId, usesServiceEdgeId } from "./glanceGraph";
import { isProjectContract, type ProjectLink } from "./projectLinks";
// Cross-feature types only, via the barrel (#1309 boundary): the consumer index (`kitUsage`) whose
// (projectKey, kitId) edges the kit nodes are built from, plus the kit→library `requires` roll-up
// (`resolveKitLibraryRefs`, #3133) the caller resolves and hands in as plain data.
import type { KitConsumer, KitLibraryRef } from "@/features/designs";
// The project's application architecture (#3786/#3802) — the contract endpoint-type discriminator carried
// onto each project node. `import type` is erased at build (no runtime edge to the planner).
import type { AppType } from "@/features/planner";

export interface GlanceData { rawNodes: GRawNode[]; rawEdges: GRawEdge[]; sample: boolean }

/** A minimal project as the adapter needs it — id + display name, plus the two axes the caller has
 *  resolved (#2541): `health` (idle/healthy/warning/error) and `activity` (the lifecycle word), with an
 *  optional `reason` (the fault title) shown when health is degraded. `appType` (#3786) is the project's
 *  application architecture — the contract endpoint-type discriminator, absent ⇒ read as "application". */
export interface ProjectLite { id: string; name: string; role?: GRole; health?: GHealth; activity?: GActivity; reason?: string; faults?: number; appType?: AppType }

/** A UI kit as the adapter needs it (#2571) — id + display name, so a kit node reads the kit's NAME
 *  (falling back to the id). The store's `Kit[]` is structurally assignable, so the caller passes it as-is. */
export interface KitLite { id: string; name: string }

/** An MCP server as the adapter needs it (#3786) — id + name + its per-server project scope + transport,
 *  so an mcp node reads the server's NAME and derives its `appType` from the transport. The store's
 *  `McpServer[]` is structurally assignable, so the caller passes it as-is. A server with an EMPTY
 *  `projects` list is GLOBAL (every session gets it) — not a specific contract, so it is skipped. */
export interface McpLite { id: string; name: string; projects: string[]; transport?: "stdio" | "http" }

/** The packaged SAMPLE project network — the spec's example (roles · edge kinds · a dependency CYCLE:
 *  reporting → analytics → reporting · hazards). No longer an auto-fallback for an empty app (#2272 — an
 *  unseeded Glance shows a REAL empty state, not the mock); kept as the seed of the curated app-state
 *  DEMO (#2272 slice 4). Marked `sample`. The nodes/edges live in `@data/glance/sample-graph.json`
 *  (#2419) — a plain embedded import, NOT config-dir-overlaid, because the demo snapshot is built on
 *  this spine and must stay byte-deterministic (stable gist bytes). */
export const SAMPLE_GRAPH: GlanceData = {
  sample: true,
  rawNodes: sampleGraphEmbedded.rawNodes as GRawNode[],
  rawEdges: sampleGraphEmbedded.rawEdges as GRawEdge[],
};

/** Build the Glance graph from the REAL project list: every project a node (its resolved role/status, or
 *  a derived role + idle). Cross-project dependency EDGES are NOT fabricated — the only project↔project
 *  edges are the user-drawn relationships (#2253), so an un-wired project is simply an isolated node. On
 *  top, one UI-KIT node per distinct `bsc ui` kit in use (#2571), edged to every consuming project so the
 *  network shows which projects SHARE a kit. Zero projects yields an EMPTY graph (`sample: false`) — the
 *  workspace renders a real empty state (#2272), no mock.
 *
 *  On top of that, the generalized CROSS-GRAPH library dimension (#3133): a project transitively `requires`
 *  every algorithm / sound node the components of its kits import, so the fenced band carries real library
 *  dependencies (the logistics example: a route-planner project → its `algo:` dijkstra node), not just kits.
 *
 *  On top of THAT, the external CONTRACT dimension (#3786): (Phase 1) one auto-derived node per MCP server
 *  SCOPED to ≥1 project in this graph, edged from each consuming project — mirroring the kit dimension; a
 *  GLOBAL server (`projects: []`) is skipped. (Phase 2) plus EXPLICIT, planner-declared contracts — a
 *  stored `ProjectLink` whose `target` is a `service` or `mcp` endpoint becomes an external band node
 *  edged from `from`, DEDUPED against the Phase-1 auto-mcp nodes by node id. A project's `appType` (#3802)
 *  is surfaced on its node as the endpoint-type discriminator.
 *
 *  @param kitUsage    the consumer index (`kitUsage`) — (projectKey, kitId) edges (from `@/features/designs`).
 *  @param kits        the kit library, so a kit node reads the kit's NAME (else its id).
 *  @param libraryRefs the kit→library `requires` roll-up (`resolveKitLibraryRefs`, #3133) — resolved by the
 *                     CALLER and memoized on the component list, because deriving it scans component source;
 *                     this function must stay cheap (it re-runs on every project-status tick).
 *  @param mcpServers  the MCP server store (#3786) — a scoped server (`projects` non-empty) becomes one
 *                     external contract node edged from each consuming project; a global server is skipped. */
export function buildGlanceData(
  projects: ProjectLite[],
  links: ProjectLink[] = [],
  kitUsage: KitConsumer[] = [],
  kits: KitLite[] = [],
  libraryRefs: KitLibraryRef[] = [],
  mcpServers: McpLite[] = [],
): GlanceData {
  const rawNodes: GRawNode[] = projects.map((p) => ({
    id: p.id,
    slug: p.name || p.id,
    // #4052 — the lifecycle CATEGORY axis is gone; an L0 project reads on health ⟂ activity, the same
    // two axes as a fleet node. `role` survives as the curated-only accent (a demo project may declare
    // one); the default is benign and the old hash-per-id tier is GONE.
    role: p.role ?? "service",
    health: p.health ?? "off",      // #2541 axis 1 — resolved by the caller from faults/liveness;
                                    // #4042: the default is `off` (nothing live behind it), not a second grey
    activity: p.activity ?? "idle", // #2551 axis 2 — RESTING default; `building` is derived from live agents, not a fallback
    reason: p.reason,                  // the fault title shown when health is degraded
    faults: p.faults,                  // #2265: unresolved runtime-fault count (inspector)
    appType: p.appType,                // #3786/#3802: the contract endpoint-type discriminator (absent ⇒ "application", rendered plain)
    // `kind` is left ABSENT here (⇒ "project", #2571) so a project node's shape is byte-identical to before.
  }));
  // The project↔project contracts (#2253) — the real edges, filtered to PROJECT-target links between two
  // nodes that still exist. No fabricated topology; an un-wired project is simply an isolated node. A
  // contract whose target is an external service / mcp server (#3786 Phase 2) is NOT a project edge — it
  // is lifted into the band below.
  const ids = new Set(rawNodes.map((n) => n.id));
  const rawEdges: GRawEdge[] = links
    .filter((l) => isProjectContract(l) && ids.has(l.from) && ids.has(l.to))
    .map((l) => ({ id: l.id, from: l.from, to: l.to, kind: l.kind }));

  // The UI-KIT dimension (#2571): one node per DISTINCT kit that has ≥1 consumer AMONG the current
  // projects, edged from every consuming project to the shared kit node. The edge follows the graph's
  // consumer→provider convention (`from depends on to`): the PROJECT consumes the kit, so `from` is the
  // project and `to` is the kit — which lays the shared kit foundational and keeps a kit's `idle` health
  // from ever rolling up into a project. A stale usage row for a project not in this graph is skipped, so
  // a kit node is never emitted without a visible edge.
  const kitName = new Map(kits.map((k) => [k.id, k.name]));
  const consumersByKit = new Map<string, string[]>();
  for (const u of kitUsage) {
    if (!ids.has(u.projectKey)) continue;                    // consumer must be a project node in this graph
    const arr = consumersByKit.get(u.kitId) ?? [];
    if (!arr.includes(u.projectKey)) arr.push(u.projectKey); // dedupe a duplicate (projectKey, kitId)
    consumersByKit.set(u.kitId, arr);
  }
  for (const [kitId, consumers] of consumersByKit) {
    rawNodes.push({
      id: kitNodeId(kitId),
      slug: kitName.get(kitId) ?? kitId,
      kind: "kit",
      role: "infra",   // a kit is a shared foundational dependency; `category` absent ⇒ the canvas draws it as a kit
      health: "off",  // #4042 — a kit never RUNS, so it has no runtime health; `off` is now exactly that
      activity: "idle",
    });
    for (const projectKey of consumers) {
      rawEdges.push({ id: usesKitEdgeId(projectKey, kitId), from: projectKey, to: kitNodeId(kitId), kind: "uses-kit" });
    }
  }

  // The generalized CROSS-GRAPH LIBRARY dimension (#3133, epic #3114) — the same fenced band, now carrying
  // ALGORITHM + SOUND nodes with `requires` edges. The dependency is TRANSITIVE and derived, never authored:
  // a project consumes a kit (`kitUsage`), that kit's components import `@bsc/algorithms/…` / `@bsc/sounds/…`
  // (`resolveKitLibraryRefs`), therefore the project requires those library nodes. Edge direction matches the
  // kit dimension (consumer→provider), so a library node lands foundational in the band alongside the kits
  // and its `idle` health never rolls up into a project.
  //
  // Emitted AFTER the kit loop and gated on `consumersByKit`, so: a project with no library-importing kit is
  // byte-identical to before, and a library node never appears without ≥1 visible edge.
  const refsByKit = new Map<string, KitLibraryRef[]>();
  for (const ref of libraryRefs) {
    const arr = refsByKit.get(ref.kitId) ?? [];
    arr.push(ref);
    refsByKit.set(ref.kitId, arr);
  }
  const seenLibNode = new Set<string>();
  const seenReqEdge = new Set<string>();
  for (const [kitId, consumers] of consumersByKit) {
    for (const ref of refsByKit.get(kitId) ?? []) {
      const nodeId = libraryNodeId(ref.graph, ref.id);
      if (!seenLibNode.has(nodeId)) {
        // Deduped ACROSS kits: two kits requiring `fibonacci` share ONE band node (that sharing is the point
        // — the band shows a library node's full consumer set).
        seenLibNode.add(nodeId);
        rawNodes.push({
          id: nodeId,
          slug: ref.label || ref.id,
          kind: "library",
          library: ref.graph,  // the band/legend/inspector colour + kind word (algorithm · sound)
          role: "infra",       // a shared foundational dependency, like a kit
          health: "off",      // #4042 — a library never runs; `off` = no live session behind this node
          activity: "idle",
        });
      }
      for (const projectKey of consumers) {
        // Deduped per (project, node): a project consuming two kits that both require `fibonacci` draws ONE
        // edge, not a doubled one.
        const id = requiresEdgeId(projectKey, nodeId);
        if (seenReqEdge.has(id)) continue;
        seenReqEdge.add(id);
        rawEdges.push({ id, from: projectKey, to: nodeId, kind: "requires" });
      }
    }
  }

  // The external MCP-CONTRACT dimension (#3786, Phase 1 inter-app contracts) — the SAME shape as the kit
  // loop, mapped onto the MCP server store: one node per server SCOPED to ≥1 project in this graph, edged
  // from every consuming project. A server with an EMPTY `projects` list is GLOBAL (every session gets it),
  // so it is NOT a specific contract and is skipped. A scoped project not in this graph is skipped, so an
  // mcp node is never emitted without a visible edge. Deduped per (project, server) like the kit loop. Edge
  // direction follows the consumer→provider convention (project consumes the server), so the mcp node lands
  // foundational in the band and its `idle` health never rolls up into a project. The mcp node's `appType`
  // is derived from its transport — http ⇒ `api`, stdio (local) ⇒ `serverless` (the user's framing: "an
  // mcp server, which can be serverless").
  const consumersByMcp = new Map<string, string[]>();   // serverId → consuming project keys (in this graph)
  const mcpById = new Map<string, McpLite>();
  for (const s of mcpServers) {
    if (s.projects.length === 0) continue;               // global — not a specific contract, skip
    for (const projectKey of s.projects) {
      if (!ids.has(projectKey)) continue;                // consumer must be a project node in this graph
      const arr = consumersByMcp.get(s.id) ?? [];
      if (!arr.includes(projectKey)) arr.push(projectKey); // dedupe a duplicate (projectKey, serverId)
      consumersByMcp.set(s.id, arr);
      mcpById.set(s.id, s);
    }
  }
  for (const [serverId, consumers] of consumersByMcp) {
    const s = mcpById.get(serverId)!;
    rawNodes.push({
      id: mcpNodeId(serverId),
      slug: s.name || serverId,
      kind: "mcp",
      role: "infra",   // an external contract is a shared foundational dependency; `category` absent ⇒ the canvas draws it as an mcp node
      appType: s.transport === "http" ? "api" : "serverless", // http endpoint ⇒ api · stdio (local) ⇒ serverless
      health: "off",  // #4042 — an external contract never runs; `off` = no live session behind this node
      activity: "idle",
    });
    for (const projectKey of consumers) {
      rawEdges.push({ id: usesMcpEdgeId(projectKey, serverId), from: projectKey, to: mcpNodeId(serverId), kind: "uses-mcp" });
    }
  }

  // EXPLICIT, PLANNER-DECLARED external contracts (#3786 Phase 2) — a stored contract whose `target` is a
  // `service` or `mcp` endpoint (not another project) becomes an external BAND node edged from `from`. This
  // GENERALIZES the Phase-1 auto-derived mcp nodes (which come from the McpServer scope) to contracts the
  // planner declares directly via `bsc project link add … --target-type`. DEDUPED against the auto-mcp
  // nodes by node id: an explicit mcp contract to a server already in the scope reuses the ONE existing
  // node (`mcp:<serverId>`) and its edge id collides, so neither node nor edge is doubled. A `service`
  // target has no auto-derivation, so it always mints its own node. Additive + data-gated: no
  // external-target contracts ⇒ nothing added (byte-identical to Phase 1).
  const seenBandNodeId = new Set(rawNodes.map((n) => n.id)); // includes the auto-mcp nodes emitted above
  const seenEdgeId = new Set(rawEdges.map((e) => e.id));
  for (const l of links) {
    const t = l.target;
    if (!t || (t.type !== "service" && t.type !== "mcp")) continue; // project targets are drawn above
    if (!ids.has(l.from)) continue;                                 // the consumer must be a project in this graph
    const nodeId = t.type === "mcp" ? mcpNodeId(l.to) : serviceNodeId(l.to);
    if (!seenBandNodeId.has(nodeId)) {
      seenBandNodeId.add(nodeId);
      rawNodes.push({
        id: nodeId,
        slug: t.name || l.to,
        kind: t.type,        // "mcp" | "service"
        role: "infra",       // an external contract is a shared foundational dependency
        appType: t.appType,  // the planner-declared endpoint type (absent ⇒ rendered plain)
        health: "off",      // #4042 — an external contract never runs; `off` = no live session behind it
        activity: "idle",
      });
    }
    const edgeId = t.type === "mcp" ? usesMcpEdgeId(l.from, l.to) : usesServiceEdgeId(l.from, l.to);
    if (!seenEdgeId.has(edgeId)) {
      seenEdgeId.add(edgeId);
      rawEdges.push({ id: edgeId, from: l.from, to: nodeId, kind: t.type === "mcp" ? "uses-mcp" : "uses-service" });
    }
  }

  return { rawNodes, rawEdges, sample: false };
}
