# Algorithm visualization — the trace contract (#3176, epic #3171)

Live visualizations for the Algorithms library, the way the component library has live previews — but
instead of hand-authoring a visualizer per algorithm, we **visualize the DATA STRUCTURES over time**.
The data structure is the unit of visualization: build a renderer per structure **once**, and every
algorithm that touches that structure animates for free.

This document is the durable contract the whole feature binds to:

- the **trace-frame skeleton** every frame follows,
- each **structure's frame + verb vocabulary**,
- the **verb → state → animation** binding convention,
- the **streaming model** (how a trace is pulled + scrubbed), and
- **how a renderer and a designed animation plug in.**

The three designable layers all sit on this contract:

| Layer | What it is | Authored where | Binds via |
|---|---|---|---|
| **Structure renderers** | one viz component per structure — `<ArrayView>`, `<MatrixView>`, `<GraphView>`, … | the Designer (they're components) | the **renderer registry** |
| **Predefined animations** | the canonical transitions — `swap`, `compare`, `visit`, `relax`, … as kit motion defs (`KitAnimation`, #2942) | the Designer's Animations menu | `data-op` / `data-mark` state triggers (#3058) |
| **The trace** | the algorithm's stream of typed structure frames, each carrying verbs | the librarian AI (per algorithm) | the **trace-frame contract** below |

The code for this foundation lives in `src/features/algorithms/`:

| File | Role |
|---|---|
| `lib/trace.ts` | the frame contract — `StructureFrame`, `Frame`, `normalizeFrame` |
| `lib/traceStream.ts` | the streaming engine — `makeTraceStream` (lazy pull + ring buffer + replay) |
| `lib/binding.ts` | the verb→state helpers — `opStateAttrs`, `nodeOpStateAttrs`, `markStateAttrs` |
| `viz/registry.tsx` | the pluggable renderer registry — `StructureRenderer`, `RendererRegistry`, `fallbackRenderer` |
| `viz/TracePlayer.tsx` | the generic player — drives the stream, lays out panels, dispatches to renderers |

---

## 1. The frame skeleton

A trace is a **stream of frames**. Each frame follows one shared skeleton:

```
{ structure, <data | topology>, ops?, cursors?, marks? }
```

- **`structure`** — the discriminant (`"array"`, `"graph"`, …); picks the renderer.
- **data / topology** — the structure's current contents (`data`, `nodes`+`edges`, `rows`, `values`).
- **`ops?`** — the transient **verbs** happening this frame (a `swap`, a `visit`). The animation binds
  to these.
- **`cursors?`** — named pointers into the structure (`{ i: 3, j: 5 }`), drawn as carets/highlights.
- **`marks?`** — durable per-element **states** (a cell reaching `sorted`, a node `visited`).

A frame is either a **bare** single-structure frame or a **multi-panel** frame:

```ts
type Frame = StructureFrame | { panels: Record<string, StructureFrame> };
```

`normalizeFrame(frame)` collapses the two so the player always deals with a named map of panels: a bare
frame becomes `{ main: frame }`; a panels frame yields its own map. A multi-structure algorithm
(Dijkstra → graph + heap + distances) yields a `{ panels }` frame whose panels animate **in sync** off
the one trace.

---

## 2. The structures and their verbs

Every structure's frame interface + op (verb) union is exported from `lib/trace.ts`. The verbs are the
contract the **librarian AI writes traces against** and the **renderers + animations bind to** — nail
them precisely; they are the durable artifact.

### array — sorts, scans, two-pointer
```ts
{ structure: "array"; data: (number|string)[]; ops?: ArrayOp[]; cursors?: Record<string, number> }
ArrayOp = { op:"compare"; at:[number,number] }
        | { op:"swap";    at:[number,number] }
        | { op:"set";     at:number }
        | { op:"mark";    at:number; as:"sorted"|"pivot"|"min" }
```

### matrix — grids, DP tables, changes-over-time (`heat`)
```ts
{ structure:"matrix"; data:(number|string)[][]; ops?:MatrixOp[]; cursors?:Record<string,[number,number]>; heat?:boolean }
MatrixOp = { op:"read";   at:[number,number] }
         | { op:"write";  at:[number,number] }
         | { op:"region"; rows:[number,number]; cols:[number,number]; as?:string }
```

### graph — BFS/DFS, shortest paths, networks
```ts
{ structure:"graph";
  nodes:{ id:string; label?:string; value?:number|string }[];
  edges:{ from:string; to:string; weight?:number }[];
  ops?:GraphOp[];
  marks?:Record<string,"start"|"goal"|"visited"|"frontier"|"current">;
  cursors?:Record<string,string> }
GraphOp = { op:"visit";    node:string }
        | { op:"frontier"; node:string }
        | { op:"relax";    edge:[string,string] }
        | { op:"path";     nodes:string[] }
```

### linked-list — traversal, splice, reversal (`doubly`)
```ts
{ structure:"linked-list"; data:(number|string)[]; ops?:ListOp[]; cursors?:Record<string,number>; doubly?:boolean }
ListOp = { op:"traverse"; at:number }
       | { op:"compare";  at:[number,number] }
       | { op:"insert";   at:number }
       | { op:"remove";   at:number }
       | { op:"relink";   from:number; to:number }
```

### tree — BSTs, heaps, balanced trees
```ts
{ structure:"tree";
  nodes:{ id:string; value:number|string; parent?:string }[];
  ops?:TreeOp[];
  marks?:Record<string,"current"|"path"|"target">;
  cursors?:Record<string,string> }
TreeOp = { op:"visit";   node:string }
       | { op:"compare"; at:[string,string] }
       | { op:"insert";  node:string; parent:string }
       | { op:"remove";  node:string }
       | { op:"rotate";  pivot:string; dir:"left"|"right" }
       | { op:"swap";    at:[string,string] }
```

### table — hash maps / sets (open addressing via `probe`)
```ts
{ structure:"table"; rows:{ key:string; value:number|string; bucket?:number }[]; buckets?:number; ops?:TableOp[]; cursors?:Record<string,string> }
TableOp = { op:"read";   key:string }
        | { op:"write";  key:string }
        | { op:"probe";  bucket:number }
        | { op:"delete"; key:string }
```

### stack — also queue / deque (via `mode`)
```ts
{ structure:"stack"; data:(number|string)[]; mode?:"stack"|"queue"|"deque"; ops?:StackOp[]; cursors?:Record<string,number> }
StackOp = { op:"push" } | { op:"pop" } | { op:"peek"; at:number }
```

### scalar — counters, accumulators, flags (`timeline` = sparkline)
```ts
{ structure:"scalar"; values:Record<string,number|string>; ops?:Record<string, ScalarOp>; timeline?:boolean }
ScalarOp = { op:"set" } | { op:"add"; delta:number } | { op:"compare"; other:number }
```
`scalar`'s `ops` is a **per-variable map** (keyed by variable name), unlike the other structures'
op arrays.

---

## 3. The binding convention — verb → state → animation

The connective tissue already exists (the motion **trigger** system: #3058 state-trigger / #3057
exit-trigger / #2942 kit animations). A frame's verbs/marks become **element data-states**; the kit's
animation is bound to that state and fires.

```
frame { structure:"array", data:[5,1,3], ops:[{op:"swap",at:[0,1]}] }
   →  renderer stamps  data-op="swap"  on cells 0 and 1
   →  the kit's state-triggered `swap` animation plays on those cells
```

**So: trace verb → element `data-op` / `data-mark` → state-triggered kit animation.** The renderer
never writes animation CSS — it only stamps the state. The kit (designed in the Designer) owns the
keyframes/timing and targets `[data-op="swap"]` / `[data-mark="sorted"]`. Change the `swap` animation
once and **every** sort visualization updates.

### The two state attributes

| Attribute | Source | Meaning | Lifetime |
|---|---|---|---|
| `data-op="<verb>"` | a frame's `ops` | the transient operation the element is in this frame | one frame (the animation) |
| `data-mark="<state>"` | a `mark` op, or a frame's `marks` record | the durable state the element has reached | persists across frames |

Convention: **at most one op targets a given element per frame** (the op IS the transient verb). Marks
are durable states an element accumulates (`sorted`, `visited`, `current`).

### The shared stamping helpers (`lib/binding.ts`)

So every renderer stamps identically, use the helpers — each returns a plain `{ "data-op"?, "data-mark"? }`
object to spread onto the element:

- **`opStateAttrs(ops, index)`** — for **numeric-indexed** structures (array / linked-list / stack).
  Stamps `data-op` for an op whose `at` targets `index`; a `mark` op stamps `data-mark` = its `as`.
  ```tsx
  {frame.data.map((v, i) => <Cell key={i} {...opStateAttrs(frame.ops, i)}>{v}</Cell>)}
  ```
- **`nodeOpStateAttrs(ops, id)`** — for **id-addressed** structures (graph / tree). Stamps `data-op`
  when an op names that id via `node` / `nodes` / `edge` / `at`.
- **`markStateAttrs(marks, key)`** — stamps `data-mark` from a frame's durable `marks` record.

Position-less ops (stack `push`/`pop`) and shape-specific ops (tree `rotate`, list `relink`) carry no
addressable element and are the renderer's own concern — but they must still follow the same
`data-op="<verb>"` convention on whatever element they animate.

### The canonical animation names

The verbs above map onto the kit's motion library — the "library of predefined animations": `swap`,
`compare`, `set`, `insert`, `remove`, `rotate`, `cell-write` (matrix read/write), `visit`, `relax`,
`path`, `probe`, `push`, `pop`. These are **designed / tried-on / live-previewed in the Designer** and
fired by the trace. A kit binds each to its state selector; see `src/shared/ui/kit/animations.ts`
(`KitAnimation` + `compileAnimationsCss`).

---

## 4. The streaming model

The trace is a **lazy generator, pulled at play speed** (not pushed to a queue) — **O(1) memory +
automatic backpressure**. The generator is suspended between yields and only produces the next frame
when the player pulls it, so a 100k-step run never materializes 100k frames; only the current frame +
the generator's suspended state (O(input)) are held.

- **Scrub-back** — a bounded **ring buffer** (~500 frames, `DEFAULT_BUFFER_SIZE`) keeps the recent
  window, so stepping back is free.
- **Scrub older than the window** — **deterministic replay**: the trace is a pure function of the
  input, so the engine re-runs the factory from the start to the target index and rebuilds the window.
  Cheap and exact.
- The real limit is **watchability, not memory** — cap mock-input size upstream (the viz teaches, it
  doesn't benchmark) and coalesce micro-steps for pathological runs (a sampling slider, not a rewrite).

This falls out of the **generator-as-source** decision: the algorithm's implementation is authored as a
step-yielding generator — the plain function drains it, the visualizer animates the yields (one source
of truth).

### The engine API (`makeTraceStream`)

```ts
const stream = makeTraceStream(factory, { bufferSize: 500 });
stream.current(): Frame | null   // the frame at the cursor (null before the first advance)
stream.next():    Frame | null   // advance one frame (pull at the frontier); null at end (cursor holds)
stream.seek(i):   Frame | null   // jump to absolute index i (buffered → free; older → replay;
                                 //   past the end → clamp); i < 0 parks before the start
stream.index():   number         // the current absolute index (-1 before the first advance)
stream.atEnd():   boolean        // generator exhausted AND cursor on the last frame
```

`factory: () => Generator<Frame>` must yield the **identical** frame sequence every call (a pure
function of its captured input) — the engine re-invokes it for deterministic replay.

---

## 5. Plugging in a renderer + a designed animation

### The renderer registry (`viz/registry.tsx`)

A structure renderer is a React component over that structure's own frame type:

```ts
type StructureRenderer<S extends StructureName> = ComponentType<{ frame: FrameOf<S> }>;
type RendererRegistry = { [S in StructureName]?: StructureRenderer<S> };
```

`RendererRegistry` is a per-key-typed `Partial<Record<StructureName, StructureRenderer>>`: a
`{ array: ArrayView }` entry is a renderer over `ArrayFrame`. The registry is **injected** into the
player — the per-structure renderer issues (#3178–#3185) add an entry to the map without editing the
player. A structure with no registered renderer falls back to `fallbackRenderer` (structure name + a
JSON dump), never a crash.

**Author a renderer** (e.g. #3178, array):
```tsx
import type { StructureRenderer } from "@/features/algorithms";
import { opStateAttrs } from "@/features/algorithms";

export const ArrayView: StructureRenderer<"array"> = ({ frame }) => (
  <Row gap={4}>
    {frame.data.map((v, i) => (
      <Cell key={i} className="array-cell" {...opStateAttrs(frame.ops, i)}>{v}</Cell>
    ))}
  </Row>
);
```
Register it: `<TracePlayer factory={sortTrace} renderers={{ array: ArrayView }} />`.

### The player (`viz/TracePlayer.tsx`)

```tsx
<TracePlayer
  factory={() => bubbleSortTrace(input)}   // memoize a stable factory identity at the call site
  renderers={{ array: ArrayView, graph: GraphView }}
  fps={4}
/>
```
The player drives the stream at `fps`, exposes play/pause/step-back/step-forward + a scrubber, calls
`normalizeFrame` on the current frame, and lays the named panels side by side — each dispatched to its
registered renderer or the fallback.

### The animation

The renderer only stamps `data-op` / `data-mark`. The **animation** is a `KitAnimation` designed in the
Designer's Animations menu (#2942), bound to the state selector (`[data-op="swap"]`), live-compiled into
the preview iframe (#3058). Designing `swap` once updates every visualization that emits a `swap` verb —
no hand-coded CSS in any renderer.

---

## Status

**#3176 (this foundation)** ships the contract types, the streaming engine, the binding helpers, the
generic player, and the pluggable (empty) registry with a fallback. The **per-structure renderers**
(#3178 array · #3179 matrix · #3180 graph · #3181 linked-list · #3182 tree/heap · #3183 table ·
#3184 stack/queue · #3185 scalar) fan out from here, and **#3177** wires the player into the inspector's
Visualization pane with the array-sort proof.
