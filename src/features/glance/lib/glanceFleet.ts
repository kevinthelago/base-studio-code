// Glance fleet drill (#…) — the L1 graph you get by clicking a project on the L0 project network: that
// project's FLEET as a graph in the same Glance node/edge language (director + workers + a reviewer,
// wired by coordination edges), so the drill reads as one recursive graph zooming in. The topology is a
// deterministic SAMPLE per project until a real per-project fleet-plan feed lands (mirrors glanceData's
// sample project topology) — isolated here so wiring the real fleet later is a drop-in.
import type { GRawNode, GRawEdge } from "./glanceGraph";
import type { GlanceData, ProjectLite } from "./glanceData";

/** Stable small hash → non-negative int (deterministic worker count / status). */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Build a project's fleet as a Glance graph: a director (infra hub), 2–4 workers (service), and a
 *  reviewer (data). Edges are "depends on": each worker depends on the director's direction (api), the
 *  reviewer reads each worker's output (data) — so the layout flows director → workers → reviewer. All
 *  clearly `sample` until a real fleet feed replaces it. */
export function buildFleetData(project: ProjectLite): GlanceData {
  const workers = 2 + (hash(project.id) % 3); // 2..4
  const rawNodes: GRawNode[] = [
    { id: "director", slug: "director", role: "infra", status: "building", director: undefined },
    { id: "reviewer", slug: "reviewer", role: "data", status: "review" },
  ];
  const rawEdges: GRawEdge[] = [];
  for (let i = 1; i <= workers; i++) {
    const id = `worker-${i}`;
    rawNodes.push({ id, slug: `worker ${i}`, role: "service", status: hash(id + project.id) % 2 ? "building" : "idle" });
    rawEdges.push({ from: id, to: "director", kind: "api" });   // worker takes direction from the director
    rawEdges.push({ from: "reviewer", to: id, kind: "data" });  // reviewer reads the worker's output
  }
  return { rawNodes, rawEdges, sample: true };
}
