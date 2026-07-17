// Multi-structure SCENE programs (#3259, epic #3171) — algorithms whose mechanics live across several
// structures, authored against a `TracedScene` so they animate as synchronized panels. This is the
// multi-structure twin of the single-datatype programs (sorts.ts / matrixTransforms.ts / graphAlgos.ts):
// each program declares NAMED panels (`scene.graph`, `scene.array`) and drives them with the ordinary
// tracer verbs; the scene folds every op into a `PanelsFrame` and the player lays the panels side by side.
import { type TracedScene, type TracedTree, type GraphInput } from "../../lib/tracer";
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

/** One priority-queue entry — a node and its tentative distance (the heap key). */
interface HeapEntry {
  dist: number;
  node: string;
}

/**
 * A binary MIN-heap (keyed by `dist`) that mirrors itself into a {@link TracedTree} panel (#3270) — this is
 * Dijkstra's real priority queue drawn as a heap tree. Node id = the entry's array index (`h<i>`), parent =
 * `h<floor((i-1)/2)>`, so the heap-as-array IS a complete binary tree. A `push` sifts up; a `pop` swaps
 * root↔last, removes the last, then sifts down (the canonical heap ops) — each reflected as insert / swap /
 * remove on the tree, so the sift animates. Used with LAZY DELETION: Dijkstra pushes a fresh entry per
 * improvement and skips a popped entry whose node is already settled.
 */
class HeapPanel {
  private readonly h: HeapEntry[] = [];
  constructor(private readonly tree: TracedTree) {}

  get size(): number {
    return this.h.length;
  }

  private id(i: number): string {
    return `h${i}`;
  }
  private label(e: HeapEntry): string {
    return `${e.node}:${e.dist}`;
  }

  /** Enqueue `(dist, node)` — insert at the back, then sift up. */
  push(dist: number, node: string): void {
    let i = this.h.length;
    const entry = { dist, node };
    this.h.push(entry);
    this.tree.insert(this.id(i), this.label(entry), i === 0 ? undefined : this.id(Math.floor((i - 1) / 2)));
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (this.h[p].dist <= this.h[i].dist) break;
      [this.h[i], this.h[p]] = [this.h[p], this.h[i]];
      this.tree.swap(this.id(i), this.id(p)); // exchange the two nodes' values (the sift)
      i = p;
    }
  }

  /** Extract the min — swap root↔last, drop the last node, then sift down. */
  pop(): HeapEntry | undefined {
    if (this.h.length === 0) return undefined;
    const last = this.h.length - 1;
    this.tree.visit(this.id(0)); // highlight the min sitting at the root
    if (last > 0) {
      [this.h[0], this.h[last]] = [this.h[last], this.h[0]];
      this.tree.swap(this.id(0), this.id(last)); // move the min to the last slot
    }
    const min = this.h.pop()!; // remove the min (now at the end)
    this.tree.remove(this.id(last)); // drop the last tree node
    let i = 0;
    const nn = this.h.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let s = i;
      if (l < nn && this.h[l].dist < this.h[s].dist) s = l;
      if (r < nn && this.h[r].dist < this.h[s].dist) s = r;
      if (s === i) break;
      [this.h[i], this.h[s]] = [this.h[s], this.h[i]];
      this.tree.swap(this.id(i), this.id(s));
      i = s;
    }
    return min;
  }
}

/**
 * Dijkstra as a SCENE (#3259 · #3268 · #3270) — FOUR panels animating TOGETHER: a `graph`, its priority-queue
 * `heap` (a min-heap tree), a `distance` array, and a `state` SCALAR readout. This is the canonical
 * multi-structure example, now with Dijkstra's *complete* mechanics on screen: you watch the graph get
 * explored (current → visit → relax) WHILE the heap sifts each frontier entry into place and pops the
 * smallest, the distance array fills in, and the scalar state ticks. Real lazy-deletion Dijkstra over the
 * SAME `TracedGraph` — the heap is the actual priority queue driving the selection, not a mirror.
 */
export function dijkstraScene(scene: TracedScene, input: GraphInput): void {
  const g = scene.graph("graph", input);
  const ids = g.ids();
  const n = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i]));

  const distVals: number[] = ids.map((_, i) => (i === 0 ? 0 : INF)); // start at 0, everything else ∞
  const heap = new HeapPanel(scene.tree("heap")); // the priority queue, drawn as a min-heap tree
  const dist = scene.array("distance", distVals);
  const state = scene.scalar("state", { current: "—", dist: 0, settled: 0 }); // the running state readout
  const visited = new Array<boolean>(n).fill(false);

  g.mark(ids[0], "start");
  heap.push(0, ids[0]); // enqueue the start
  g.frontier(ids[0]);
  while (heap.size > 0) {
    const top = heap.pop()!; // extract the min-distance frontier entry
    const u = idx.get(top.node);
    if (u === undefined || visited[u]) continue; // stale entry (lazy deletion) — already settled

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
        dist.set(v, cand);       // the improved distance lands — the array cell flashes
        heap.push(cand, nb.to);  // enqueue the improved entry into the priority queue
        g.frontier(nb.to);       // (re-)enter the frontier
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
