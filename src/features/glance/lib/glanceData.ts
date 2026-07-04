// Glance data adapter (#2206) — bridges the app's REAL project list into the graph model. Nodes come
// from the user's projects; the TOPOLOGY (roles · edge kinds · dependencies · status) is clearly-marked
// SAMPLE until a real cross-project dependency model exists (epic #2205, slice 4). Isolated here so
// wiring real edges later is a drop-in — the page + graph core never change.
import type { GRawNode, GRawEdge, GRole, GStatus } from "./glanceGraph";
import type { ProjectLink } from "./projectLinks";

export interface GlanceData { rawNodes: GRawNode[]; rawEdges: GRawEdge[]; sample: boolean }

/** A minimal project as the adapter needs it — id + display name, plus optional real role/status the
 *  caller has resolved (e.g. a live-running detection, or "planning" once a fleet exists). */
export interface ProjectLite { id: string; name: string; role?: GRole; status?: GStatus }

const ROLES: GRole[] = ["infra", "service", "data", "client"];

/** Stable small hash of a string → non-negative int (deterministic role/status assignment). */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The packaged SAMPLE project network — the spec's example (roles · edge kinds · a dependency CYCLE ·
 *  hazards). No longer an auto-fallback for an empty app (#2272 — an unseeded Glance shows a REAL empty
 *  state, not the mock); kept as the seed of the curated app-state DEMO (#2272 slice 4). Marked `sample`. */
export const SAMPLE_GRAPH: GlanceData = {
  sample: true,
  rawNodes: [
    { id: "auth-core", role: "infra", status: "done" },
    { id: "events-bus", role: "infra", status: "done" },
    { id: "identity-svc", role: "service", status: "building" },
    { id: "ledger", role: "data", status: "review" },
    { id: "notifications", role: "service", status: "idle" },
    { id: "analytics", role: "data", status: "blocked" },
    { id: "user-api", role: "service", status: "building" },
    { id: "billing-svc", role: "service", status: "planning" },
    { id: "reporting", role: "data", status: "blocked" },
    { id: "search-svc", role: "service", status: "idle" },
    { id: "payments-gw", role: "service", status: "review" },
    { id: "mobile-app", role: "client", status: "planning" },
    { id: "admin-console", role: "client", status: "idle" },
    { id: "web-app", role: "client", status: "building" },
  ],
  rawEdges: [
    { from: "identity-svc", to: "auth-core", kind: "api" },
    { from: "user-api", to: "identity-svc", kind: "api" },
    { from: "billing-svc", to: "identity-svc", kind: "api" },
    { from: "billing-svc", to: "ledger", kind: "data" },
    { from: "payments-gw", to: "billing-svc", kind: "api" },
    { from: "ledger", to: "events-bus", kind: "events" },
    { from: "notifications", to: "events-bus", kind: "events" },
    { from: "analytics", to: "events-bus", kind: "events" },
    { from: "web-app", to: "user-api", kind: "api" },
    { from: "web-app", to: "billing-svc", kind: "api" },
    { from: "web-app", to: "search-svc", kind: "api" },
    { from: "mobile-app", to: "user-api", kind: "api" },
    { from: "mobile-app", to: "notifications", kind: "api" },
    { from: "search-svc", to: "user-api", kind: "api" },
    { from: "reporting", to: "ledger", kind: "data" },
    { from: "reporting", to: "analytics", kind: "data" },
    { from: "analytics", to: "reporting", kind: "data" }, // closes a cycle with the previous edge
    { from: "admin-console", to: "user-api", kind: "api" },
    { from: "admin-console", to: "billing-svc", kind: "api" },
    { from: "admin-console", to: "reporting", kind: "data" },
  ],
};

/** Build the Glance graph from the REAL project list: every project a node (its resolved role/status, or
 *  a derived role + idle). Cross-project dependency EDGES are NOT fabricated — the only edges are the
 *  user-drawn relationships (#2253), so an un-wired project is simply an isolated node. Zero projects
 *  yields an EMPTY graph (`sample: false`) — the workspace renders a real empty state (#2272), no mock. */
export function buildGlanceData(projects: ProjectLite[], links: ProjectLink[] = []): GlanceData {
  const rawNodes: GRawNode[] = projects.map((p) => ({
    id: p.id,
    slug: p.name || p.id,
    role: p.role ?? ROLES[hash(p.id) % ROLES.length],
    status: p.status ?? "idle",
  }));
  // The user-drawn project relationships (#2253) — the real edges, filtered to links between two nodes
  // that still exist. No fabricated topology; an un-wired project is simply an isolated node.
  const ids = new Set(rawNodes.map((n) => n.id));
  const rawEdges: GRawEdge[] = links
    .filter((l) => ids.has(l.from) && ids.has(l.to))
    .map((l) => ({ id: l.id, from: l.from, to: l.to, kind: l.kind }));
  return { rawNodes, rawEdges, sample: false };
}
