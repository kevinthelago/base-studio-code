// Multi-structure SCENE programs (#3259, epic #3171) — algorithms whose mechanics live across several
// structures, authored against a `TracedScene` so they animate as synchronized panels. This is the
// multi-structure twin of the single-datatype programs (sorts.ts / matrixTransforms.ts / graphAlgos.ts):
// each program declares NAMED panels (`scene.graph`, `scene.array`) and drives them with the ordinary
// tracer verbs; the scene folds every op into a `PanelsFrame` and the player lays the panels side by side.
import { type TracedScene, type TracedTree, type GraphInput } from "../../lib/tracer";
import { WEIGHTED_GRAPH, DEFAULT_GRAPH, graphToText, parseGraphInput } from "./graphAlgos";
import { SORT_MOCK, parseSortInput } from "./sort";

/** A scene's INPUT SEAM (#3284) — its default seed plus how to render/parse that seed as the editable "your
 *  input" text. A scene declares its own seam so it can seed on a graph, a number array, … (not just a
 *  graph); `serialize`/`parse` round-trip the seed to/from the field text. */
export interface SceneSeed<I> {
  default: I;
  hint: string;
  serialize: (input: I) => string;
  parse: (text: string) => I;
}

/** A multi-structure scene program keyed by BASE NAME. `run` drives the scene from the seed input; `seed`
 *  carries the default + its input seam. The input type is ERASED to `unknown` in the stored form (so
 *  `SCENE_PROGRAMS` is one uniform map across graph- and array-seeded scenes) — {@link defineScene} keeps
 *  authoring type-safe and does the erasing cast in ONE place. */
export interface SceneProgram {
  run: (scene: TracedScene, input: unknown) => void;
  seed: SceneSeed<unknown>;
}

/** Pair a typed scene `run` with a matching typed {@link SceneSeed}, erasing the input type so the result
 *  drops into the uniform `SCENE_PROGRAMS` map. The one cast site — authoring stays fully typed. */
function defineScene<I>(run: (scene: TracedScene, input: I) => void, seed: SceneSeed<I>): SceneProgram {
  return { run: run as (scene: TracedScene, input: unknown) => void, seed: seed as SceneSeed<unknown> };
}

/** A graph seed seam — the adjacency-list "your input" field (Dijkstra / BFS). */
function graphSeed(def: GraphInput): SceneSeed<GraphInput> {
  return { default: def, hint: "An adjacency list — one node per line: a: b, c", serialize: graphToText, parse: parseGraphInput };
}

/** A number-array seed seam — the comma/space field (the sorts). */
function arraySeed(def: readonly number[]): SceneSeed<readonly number[]> {
  return { default: def, hint: "Comma- or space-separated numbers", serialize: (a) => a.join(", "), parse: parseSortInput };
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

/**
 * Merge sort as a SCENE (#3284) — an `array` panel (sorted in place) + a `merge` buffer panel that makes
 * the two runs VISIBLE. Bottom-up: copy each run pair into the buffer (they appear), then merge them back
 * into the array — a real `buf.compare(i, j)` flashes the two run fronts (the merge decision the flat
 * single-array trace hid), `cursors` mark the fronts, and `arr.set(k, …)` lands the winner. Real merge sort;
 * the buffer is the auxiliary array merge sort actually needs. This is the first ARRAY-seeded scene.
 */
export function mergeSortScene(scene: TracedScene, input: readonly number[]): void {
  const n = input.length;
  const arr = scene.array("array", input);      // sorted in place — the winners land here
  const buf = scene.array("merge", [...input]); // the scratch buffer that holds the two runs

  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + 2 * width, n);
      // Copy the current range into the buffer — the two sorted runs become visible.
      for (let k = lo; k < hi; k++) buf.set(k, arr.get(k));
      // Merge buf[lo..mid) and buf[mid..hi) back into arr, comparing the two fronts.
      let i = lo;
      let j = mid;
      for (let k = lo; k < hi; k++) {
        buf.cursor("i", i < mid ? i : null); // the two front-pointers walk the runs
        buf.cursor("j", j < hi ? j : null);
        let takeLeft: boolean;
        if (i >= mid) takeLeft = false;
        else if (j >= hi) takeLeft = true;
        else takeLeft = buf.compare(i, j) <= 0; // the merge decision — both fronts flash
        arr.set(k, buf.get(takeLeft ? i++ : j++)); // the winner slides into the output
      }
    }
  }
  arr.markSorted();
}

/** The scene programs, keyed by base name (merged LAST into the registry, so a scene supersedes any
 *  single-structure program of the same name — e.g. `dijkstra` → graph+dist, `bfs` → graph+queue,
 *  `merge-sort` → array+buffer). Each carries its own input {@link SceneSeed} (graph or number-array). */
export const SCENE_PROGRAMS: Record<string, SceneProgram> = {
  dijkstra: defineScene(dijkstraScene, graphSeed(WEIGHTED_GRAPH)),
  bfs: defineScene(bfsScene, graphSeed(DEFAULT_GRAPH)),
  "merge-sort": defineScene(mergeSortScene, arraySeed(SORT_MOCK)),
};
