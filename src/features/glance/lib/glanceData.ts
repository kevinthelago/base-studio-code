// Glance data adapter (#2206) — bridges the app's REAL project list into the graph model. Nodes come
// from the user's projects; the TOPOLOGY (roles · edge kinds · dependencies · status) is clearly-marked
// SAMPLE until a real cross-project dependency model exists (epic #2205, slice 4). Isolated here so
// wiring real edges later is a drop-in — the page + graph core never change.
import sampleGraphEmbedded from "@data/glance/sample-graph.json";
import type { GRawNode, GRawEdge, GRole, GCategory, GHealth, GActivity } from "./glanceGraph";
import { kitNodeId, usesKitEdgeId, libraryNodeId, requiresEdgeId } from "./glanceGraph";
import type { ProjectLink } from "./projectLinks";
// Cross-feature types only, via the barrel (#1309 boundary): the consumer index (`kitUsage`) whose
// (projectKey, kitId) edges the kit nodes are built from, plus the kit→library `requires` roll-up
// (`resolveKitLibraryRefs`, #3133) the caller resolves and hands in as plain data.
import type { KitConsumer, KitLibraryRef } from "@/features/designs";

export interface GlanceData { rawNodes: GRawNode[]; rawEdges: GRawEdge[]; sample: boolean }

/** A minimal project as the adapter needs it — id + display name, plus the two axes the caller has
 *  resolved (#2541): `health` (idle/healthy/warning/error) and `activity` (the lifecycle word), with an
 *  optional `reason` (the fault title) shown when health is degraded. */
export interface ProjectLite { id: string; name: string; role?: GRole; category?: GCategory; health?: GHealth; activity?: GActivity; reason?: string; faults?: number }

/** A UI kit as the adapter needs it (#2571) — id + display name, so a kit node reads the kit's NAME
 *  (falling back to the id). The store's `Kit[]` is structurally assignable, so the caller passes it as-is. */
export interface KitLite { id: string; name: string }

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
 *  @param kitUsage    the consumer index (`kitUsage`) — (projectKey, kitId) edges (from `@/features/designs`).
 *  @param kits        the kit library, so a kit node reads the kit's NAME (else its id).
 *  @param libraryRefs the kit→library `requires` roll-up (`resolveKitLibraryRefs`, #3133) — resolved by the
 *                     CALLER and memoized on the component list, because deriving it scans component source;
 *                     this function must stay cheap (it re-runs on every project-status tick). */
export function buildGlanceData(
  projects: ProjectLite[],
  links: ProjectLink[] = [],
  kitUsage: KitConsumer[] = [],
  kits: KitLite[] = [],
  libraryRefs: KitLibraryRef[] = [],
): GlanceData {
  const rawNodes: GRawNode[] = projects.map((p) => ({
    id: p.id,
    slug: p.name || p.id,
    // Colour a project by its LIFECYCLE category (#2583), resolved by the caller. `role` is retained only
    // as a benign default (the canvas colours L0 nodes by `category`); the old hash-per-id tier is GONE.
    role: p.role ?? "service",
    category: p.category,
    health: p.health ?? "idle",     // #2541 axis 1 — resolved by the caller from faults/liveness
    activity: p.activity ?? "idle", // #2551 axis 2 — RESTING default; `building` is derived from live agents, not a fallback
    reason: p.reason,                  // the fault title shown when health is degraded
    faults: p.faults,                  // #2265: unresolved runtime-fault count (inspector)
    // `kind` is left ABSENT here (⇒ "project", #2571) so a project node's shape is byte-identical to before.
  }));
  // The user-drawn project relationships (#2253) — the real edges, filtered to links between two nodes
  // that still exist. No fabricated topology; an un-wired project is simply an isolated node.
  const ids = new Set(rawNodes.map((n) => n.id));
  const rawEdges: GRawEdge[] = links
    .filter((l) => ids.has(l.from) && ids.has(l.to))
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
      health: "idle",  // a kit has no runtime health of its own — it never pulls a consumer's dot
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
          health: "idle",      // a library node has no runtime health of its own
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

  return { rawNodes, rawEdges, sample: false };
}
