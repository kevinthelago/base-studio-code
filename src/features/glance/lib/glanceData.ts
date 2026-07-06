// Glance data adapter (#2206) — bridges the app's REAL project list into the graph model. Nodes come
// from the user's projects; the TOPOLOGY (roles · edge kinds · dependencies · status) is clearly-marked
// SAMPLE until a real cross-project dependency model exists (epic #2205, slice 4). Isolated here so
// wiring real edges later is a drop-in — the page + graph core never change.
import sampleGraphEmbedded from "@data/glance/sample-graph.json";
import type { GRawNode, GRawEdge, GRole, GStatus } from "./glanceGraph";
import type { ProjectLink } from "./projectLinks";
import { hashAbs } from "./hash";

export interface GlanceData { rawNodes: GRawNode[]; rawEdges: GRawEdge[]; sample: boolean }

/** A minimal project as the adapter needs it — id + display name, plus optional real role/status the
 *  caller has resolved (e.g. a live-running detection, or "planning" once a fleet exists). */
export interface ProjectLite { id: string; name: string; role?: GRole; status?: GStatus; faults?: number }

const ROLES: GRole[] = ["infra", "service", "data", "client"];

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
 *  a derived role + idle). Cross-project dependency EDGES are NOT fabricated — the only edges are the
 *  user-drawn relationships (#2253), so an un-wired project is simply an isolated node. Zero projects
 *  yields an EMPTY graph (`sample: false`) — the workspace renders a real empty state (#2272), no mock. */
export function buildGlanceData(projects: ProjectLite[], links: ProjectLink[] = []): GlanceData {
  const rawNodes: GRawNode[] = projects.map((p) => ({
    id: p.id,
    slug: p.name || p.id,
    role: p.role ?? ROLES[hashAbs(p.id) % ROLES.length],
    status: p.status ?? "idle",
    faults: p.faults, // #2265: unresolved runtime-fault count → node fault badge
  }));
  // The user-drawn project relationships (#2253) — the real edges, filtered to links between two nodes
  // that still exist. No fabricated topology; an un-wired project is simply an isolated node.
  const ids = new Set(rawNodes.map((n) => n.id));
  const rawEdges: GRawEdge[] = links
    .filter((l) => ids.has(l.from) && ids.has(l.to))
    .map((l) => ({ id: l.id, from: l.from, to: l.to, kind: l.kind }));
  return { rawNodes, rawEdges, sample: false };
}
