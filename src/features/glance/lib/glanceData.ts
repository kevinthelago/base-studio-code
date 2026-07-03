// Glance data adapter (#2206) — bridges the app's REAL project list into the graph model. Nodes come
// from the user's projects; the TOPOLOGY (roles · edge kinds · dependencies · status) is clearly-marked
// SAMPLE until a real cross-project dependency model exists (epic #2205, slice 4). Isolated here so
// wiring real edges later is a drop-in — the page + graph core never change.
import type { GRawNode, GRawEdge, GRole, GEdgeKind } from "./glanceGraph";

export interface GlanceData { rawNodes: GRawNode[]; rawEdges: GRawEdge[]; sample: boolean }

/** A minimal project as the adapter needs it (id + display name). */
export interface ProjectLite { id: string; name: string }

const ROLES: GRole[] = ["infra", "service", "data", "client"];
const KINDS: GEdgeKind[] = ["api", "data", "events"];

/** Stable small hash of a string → non-negative int (deterministic role/status assignment). */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The packaged SAMPLE project network — the spec's example. Shown when the user has too few real
 *  projects to make an interesting graph, so the full experience (roles · edge kinds · a dependency
 *  CYCLE · hazards) is always demonstrable. Marked `sample`. */
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

/** Build the Glance graph data from the real project list. With ≥3 real projects we render THEM as the
 *  nodes (role derived, status idle — the live status overlay is a follow-up) wired by a deterministic
 *  SAMPLE dependency chain (marked sample); otherwise we fall back to {@link SAMPLE_GRAPH} so the page
 *  is never empty and the full experience is demonstrable. */
export function buildGlanceData(projects: ProjectLite[]): GlanceData {
  if (projects.length < 3) return SAMPLE_GRAPH;

  const rawNodes: GRawNode[] = projects.map((p) => ({
    id: p.id,
    slug: p.name || p.id,
    role: ROLES[hash(p.id) % ROLES.length],
    status: "idle",
  }));

  // A deterministic sample DAG: each project depends on ~1–2 earlier ones (by hash), so the layout has
  // depth without inventing real relationships. Plus one forced mutual pair to demonstrate cycle
  // hazards. All clearly sample.
  const rawEdges: GRawEdge[] = [];
  for (let i = 1; i < rawNodes.length; i++) {
    const a = rawNodes[i];
    const t1 = rawNodes[hash(a.id + "1") % i];
    rawEdges.push({ from: a.id, to: t1.id, kind: KINDS[hash(a.id) % KINDS.length] });
    if (i > 2 && hash(a.id + "2") % 3 === 0) {
      const t2 = rawNodes[hash(a.id + "2") % i];
      if (t2.id !== t1.id) rawEdges.push({ from: a.id, to: t2.id, kind: KINDS[hash(a.id + "k") % KINDS.length] });
    }
  }
  // Force a mutual pair (cycle) between the first two projects so the hazard UI is exercised.
  rawEdges.push({ from: rawNodes[0].id, to: rawNodes[1].id, kind: "data" });
  rawEdges.push({ from: rawNodes[1].id, to: rawNodes[0].id, kind: "data" });

  return { rawNodes, rawEdges, sample: true };
}
