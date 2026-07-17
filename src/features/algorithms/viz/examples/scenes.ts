// Multi-structure SCENE programs (#3259, epic #3171) — algorithms whose mechanics live across several
// structures, authored against a `TracedScene` so they animate as synchronized panels. This is the
// multi-structure twin of the single-datatype programs (sorts.ts / matrixTransforms.ts / graphAlgos.ts):
// each program declares NAMED panels (`scene.graph`, `scene.array`) and drives them with the ordinary
// tracer verbs; the scene folds every op into a `PanelsFrame` and the player lays the panels side by side.
import { type TracedScene, type GraphInput } from "../../lib/tracer";
import { WEIGHTED_GRAPH, DEFAULT_GRAPH } from "./graphAlgos";

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
 * Dijkstra as a SCENE (#3259 · #3268) — three panels animating TOGETHER: a `graph`, a `distance` array, and
 * a `state` SCALAR readout (the node being finalized + how many are settled). This is the canonical
 * multi-structure example the frame model cites: you watch the graph get explored (current → visit → relax)
 * WHILE the distance array fills in (a cell flashes on each improvement) AND the scalar state ticks (the
 * current pointer moves, the settled counter increments) — so every mechanic a single-graph trace hides
 * becomes a co-star. Real Dijkstra over the SAME `TracedGraph`; the distances + state mirror its progress.
 */
export function dijkstraScene(scene: TracedScene, input: GraphInput): void {
  const g = scene.graph("graph", input);
  const ids = g.ids();
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));

  const distVals: number[] = ids.map((_, i) => (i === 0 ? 0 : INF)); // start at 0, everything else ∞
  const dist = scene.array("distance", distVals);
  const state = scene.scalar("state", { current: "—", dist: 0, settled: 0 }); // the running state readout
  const visited = new Array<boolean>(n).fill(false);

  g.mark(ids[0], "start");
  for (let k = 0; k < n; k++) {
    // Pick the unvisited node with the smallest tentative distance.
    let u = -1;
    let best = INF + 1;
    for (let i = 0; i < n; i++) if (!visited[i] && distVals[i] < best) { best = distVals[i]; u = i; }
    if (u < 0 || best >= INF) break; // done — the rest are unreachable

    visited[u] = true;
    g.current(ids[u]);              // point at the node being settled
    dist.mark(u, "min");            // lock in its distance cell
    state.set("current", ids[u]);   // which node we're finalizing
    state.set("dist", distVals[u]); // its now-final shortest distance
    state.add("settled", 1);        // one more node done
    g.visit(ids[u]);                // finish it

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

/**
 * BFS as a SCENE (#3266) — a `graph` panel + a FIFO `queue` panel animating TOGETHER. The frontier queue
 * is the structure that MAKES it breadth-first: neighbours are enqueued (push to the back) as they're
 * discovered, and the FRONT is dequeued to visit next, so nodes come out in distance-from-start order.
 * Real BFS over the SAME `TracedGraph`; the queue mirrors its frontier faithfully (push/pop = enqueue/
 * dequeue). This is the honest fit for the stack/queue renderer — unlike Dijkstra's PRIORITY queue (a heap).
 */
export function bfsScene(scene: TracedScene, input: GraphInput): void {
  const g = scene.graph("graph", input);
  const q = scene.stack("queue", "queue"); // FIFO frontier — front dequeues, back enqueues
  const start = g.ids()[0];
  if (!start) return;
  const seen = new Set<string>([start]);

  g.mark(start, "start");
  q.push(start);        // enqueue the start
  g.frontier(start);
  while (q.size > 0) {
    const u = q.pop() as string; // dequeue the FRONT
    g.current(u);
    g.visit(u);
    for (const nb of g.neighbours(u)) {
      if (seen.has(nb.to)) continue;
      seen.add(nb.to);
      g.relax(u, nb.to); // light the tree edge to the newly discovered node
      q.push(nb.to);     // enqueue it
      g.frontier(nb.to);
    }
  }
}

/** The scene programs, keyed by base name (merged LAST into the registry, so a scene supersedes any
 *  single-structure program of the same name — e.g. `dijkstra` → graph+dist, `bfs` → graph+queue). */
export const SCENE_PROGRAMS: Record<string, SceneProgram> = {
  dijkstra: { run: dijkstraScene, defaultInput: WEIGHTED_GRAPH },
  bfs: { run: bfsScene, defaultInput: DEFAULT_GRAPH },
};
