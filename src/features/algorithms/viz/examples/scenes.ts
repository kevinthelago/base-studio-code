// Multi-structure SCENE programs (#3259, epic #3171) — algorithms whose mechanics live across several
// structures, authored against a `TracedScene` so they animate as synchronized panels. This is the
// multi-structure twin of the single-datatype programs (sorts.ts / matrixTransforms.ts / graphAlgos.ts):
// each program declares NAMED panels (`scene.graph`, `scene.array`) and drives them with the ordinary
// tracer verbs; the scene folds every op into a `PanelsFrame` and the player lays the panels side by side.
import { type TracedScene, type GraphInput } from "../../lib/tracer";
import { WEIGHTED_GRAPH } from "./graphAlgos";

/** A scene program keyed by BASE NAME (like the other program registries). `run` gets the scene + the
 *  seed input (the graph, for the current graph-seeded scenes); `defaultInput` seeds the preview. */
export interface SceneProgram {
  run: (scene: TracedScene, input: GraphInput) => void;
  defaultInput: GraphInput;
}

/** The ∞ sentinel for the distance array — the array panel holds numbers, so an unreached node reads as a
 *  large value (every real distance in the sample graph is well under it). */
const INF = 99;

/**
 * Dijkstra as a SCENE (#3259) — a `graph` panel + a `distance` array panel animating TOGETHER. This is the
 * canonical multi-structure example the frame model cites: you watch the graph get explored (current →
 * visit → relax) WHILE the distance array fills in (a cell flashes on each improvement), so the mechanic
 * that a single-graph trace hides — the distances being computed — becomes the co-star. Real Dijkstra over
 * the SAME `TracedGraph`; the distances are mirrored into the array panel as they update.
 */
export function dijkstraScene(scene: TracedScene, input: GraphInput): void {
  const g = scene.graph("graph", input);
  const ids = g.ids();
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));

  const distVals: number[] = ids.map((_, i) => (i === 0 ? 0 : INF)); // start at 0, everything else ∞
  const dist = scene.array("distance", distVals);
  const visited = new Array<boolean>(n).fill(false);

  g.mark(ids[0], "start");
  for (let k = 0; k < n; k++) {
    // Pick the unvisited node with the smallest tentative distance.
    let u = -1;
    let best = INF + 1;
    for (let i = 0; i < n; i++) if (!visited[i] && distVals[i] < best) { best = distVals[i]; u = i; }
    if (u < 0 || best >= INF) break; // done — the rest are unreachable

    visited[u] = true;
    g.current(ids[u]);   // point at the node being settled
    dist.mark(u, "min"); // lock in its distance cell
    g.visit(ids[u]);     // finish it

    for (const nb of g.neighbours(ids[u])) {
      const v = idx.get(nb.to);
      if (v === undefined || visited[v]) continue;
      g.relax(ids[u], nb.to); // light the edge being considered
      const cand = distVals[u] + nb.weight;
      if (cand < distVals[v]) {
        distVals[v] = cand;
        dist.set(v, cand);     // the improved distance lands — the array cell flashes
        g.frontier(nb.to);     // (re-)enter the frontier
      }
    }
  }
}

/** The scene programs, keyed by base name (merged LAST into the registry, so a scene supersedes any
 *  single-structure program of the same name — e.g. `dijkstra` upgrades from a lone graph to graph+dist). */
export const SCENE_PROGRAMS: Record<string, SceneProgram> = {
  dijkstra: { run: dijkstraScene, defaultInput: WEIGHTED_GRAPH },
};
