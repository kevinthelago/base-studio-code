// The impl → visualization registry (#3177/#3216, epic #3171/#3215) — the lookup the Algorithms inspector
// uses to decide whether a focused implementation has a live Visualization pane, and, if so, WHAT to play.
//
// PROGRAM-DRIVEN (#3216): the trace comes from RUNNING the algorithm's own trace-program against an
// instrumented structure (see lib/tracer.ts + viz/examples/sorts.ts), keyed by the algorithm's base name.
// So each algorithm animates by ITS OWN mechanics — bubble/insertion/quick/heap/merge look different
// because they ARE different. An impl with no program shows NO animation (never a wrong category one).
// This SUPERSEDES the category-representative per-kind example (#3209 S2). `kind` (#3210) stays for the
// datatype-renderer pick + `bsc graph doctor`; `resolveKind` is retained for those.
//
// SCOPE (slice B, #3215): today the programs are in-app modules. The durable end state runs the program
// from the impl's STORED code in the preview sandbox (`shared/lib/preview/`, #3177), so the librarian
// authors visualizations as data — no per-algorithm app change.

import type { Frame } from "../../lib/trace";
import type { AlgoImpl, AlgoKind } from "../../lib/knowledge";
import { classifyKind, type Classifiable } from "../../lib/classifyKind";
import { runAlgorithm, runMatrixAlgorithm, runGraphAlgorithm, runScalarAlgorithm, runStackAlgorithm, runTreeAlgorithm, runScene, type GraphInput } from "../../lib/tracer";
import { runInSandbox } from "./vizSandbox";
import type { VizRun } from "./vizProgram";
import type { RendererRegistry } from "../registry";
import { ArrayView } from "../renderers/ArrayView";
import { MatrixView } from "../renderers/MatrixView";
import { GraphView } from "../renderers/GraphView";
import { StackView } from "../renderers/StackView";
import { ScalarView } from "../renderers/ScalarView";
import { TreeView } from "../renderers/TreeView";
import { parseSortInput } from "./sort";
import { TRACE_PROGRAMS, programKey, type AlgoProgram } from "./sorts";
import { MATRIX_PROGRAMS, parseMatrixInput, matrixToText, type MatrixProgram } from "./matrixTransforms";
import { GRAPH_PROGRAMS, parseGraphInput, graphToText, type GraphProgram } from "./graphAlgos";
import { SEARCH_PROGRAMS, parseSearchInput, searchToText, type SearchInput, type SearchProgram } from "./searches";
import { SCALAR_PROGRAMS, parseScalarInput, parseScalarSeed, scalarToText, scalarSeedToText, type ScalarProgram } from "./scalarAlgos";
import { STACK_PROGRAMS, parseStackText, stackToText, type StackProgram } from "./stackAlgos";
import { TREE_PROGRAMS, parseTreeInput, treeToText, type TreeProgram } from "./treeAlgos";
import { SCENE_PROGRAMS, type SceneProgram } from "./scenes";

/** A ready-to-play visualization: a stable default factory (the inline preview) + the per-structure
 *  renderers the player dispatches to + an editable INPUT seam (#3199) that powers the "your input" field. */
export interface VizExample {
  /** A fresh trace generator from the default input. STABLE identity (built once per algorithm below), so
   *  the inspector hands it straight to `<TracePlayer factory>` without re-memoizing. */
  factory: () => Generator<Frame>;
  /** The renderers this example needs (array → {@link ArrayView}). */
  renderers: RendererRegistry;
  /** The trace-program SOURCE to show beside the animation, with the executing op highlighted (#3250).
   *
   *  Present only for a STORED `vizCode` example — that string is the code that actually ran, so its
   *  offsets are real provenance. An in-app program is a compiled TS module with no runtime source, and
   *  an impl's reference `code` facet (often Rust) is a non-executed twin whose lines do not correspond
   *  to these frames — pairing the animation with either would be a confident lie, so both leave this
   *  `undefined` and the stage simply shows no code column. */
  source?: string;
  /** The editable input driving the trace (#3199) — `parse` turns the field text into typed input (throwing
   *  a helpful Error on invalid input); `make` RE-RUNS the program on it, returning a fresh trace factory.
   *  It is ASYNC (#3233): a stored-`vizCode` re-run goes through the sandbox Worker; in-app programs resolve
   *  immediately. `await make(parse(default))` reproduces `factory`. The seam is `unknown` so the registry
   *  can hold mixed input shapes. */
  input: {
    default: string;
    hint: string;
    parse: (text: string) => unknown;
    make: (parsed: unknown) => Promise<() => Generator<Frame>>;
  };
}

/** A stable trace factory that REPLAYS a precomputed frame array — a fresh generator per call, so the
 *  player can restart from frame 0. Used to replay the sandbox's Worker-computed frames on the main thread. */
function replay(frames: Frame[]): () => Generator<Frame> {
  return function* () {
    yield* frames;
  };
}

/** Build a stable {@link VizExample} that RUNS `program` (its real code) via the tracer — the default
 *  factory plus the "your input" seam that re-runs the same program on the user's numbers. */
function exampleFromProgram(program: AlgoProgram): VizExample {
  return {
    factory: runAlgorithm(program.run, program.defaultInput),
    renderers: { array: ArrayView },
    input: {
      default: program.defaultInput.join(", "),
      hint: "Comma- or space-separated numbers",
      parse: (text) => parseSortInput(text),
      make: async (parsed) => runAlgorithm(program.run, parsed as number[]),
    },
  };
}

/** Build a stable search {@link VizExample} that RUNS a search (#3220) via the TracedArray — the same
 *  `<ArrayView>` the sorts use, but the trace is `probe`/`found` instead of compare/swap. The input seam
 *  carries BOTH halves of a search (the values AND the target), so "your input" can change either. */
function searchExampleFromProgram(program: SearchProgram): VizExample {
  const trace = (input: SearchInput) => runAlgorithm((a) => void program.run(a, input.target), input.values);
  return {
    factory: trace(program.defaultInput),
    renderers: { array: ArrayView },
    input: {
      default: searchToText(program.defaultInput),
      hint: "Numbers, then the target after a '|' (e.g. 1, 3, 5 | 3)",
      parse: (text) => parseSearchInput(text),
      make: async (parsed) => trace(parsed as SearchInput),
    },
  };
}

/** Build a stable scalar {@link VizExample} that RUNS an accumulate program (#3220) via the TracedScalar —
 *  the `<ScalarView>` named-variable chips, seeded from the program's single `n` parameter. */
function scalarExampleFromProgram(program: ScalarProgram): VizExample {
  return {
    factory: runScalarAlgorithm(program.run, program.defaultInput),
    renderers: { scalar: ScalarView },
    input: {
      default: scalarToText(program.defaultInput),
      hint: "A single whole number, n (e.g. 10)",
      parse: (text) => parseScalarInput(text),
      make: async (parsed) => runScalarAlgorithm(program.run, parsed as Record<string, number | string>),
    },
  };
}

/** Build a stable matrix {@link VizExample} that RUNS a matrix transform (#3221) via the TracedMatrix, with
 *  a square-grid "your input" seam. */
function matrixExampleFromProgram(program: MatrixProgram): VizExample {
  return {
    factory: runMatrixAlgorithm(program.run, program.defaultInput),
    renderers: { matrix: MatrixView },
    input: {
      default: matrixToText(program.defaultInput),
      hint: "A square grid — cells by comma/space, rows by ';' (e.g. 1,2 ; 3,4)",
      parse: (text) => parseMatrixInput(text),
      make: async (parsed) => runMatrixAlgorithm(program.run, parsed as number[][]),
    },
  };
}

/** Build a stable stack {@link VizExample} that RUNS a stack algorithm (#3220) via the TracedStack. The
 *  parser + hint come from the PROGRAM, not this factory — the two stack algorithms read different input
 *  languages (see {@link StackProgram}). */
function stackExampleFromProgram(program: StackProgram): VizExample {
  const factoryFor = (input: string) => runStackAlgorithm((s) => program.run(s, input), program.mode);
  return {
    factory: factoryFor(program.defaultInput),
    renderers: { stack: StackView },
    input: {
      default: stackToText(program.defaultInput),
      hint: program.hint,
      parse: (text) => program.parse(text),
      make: async (parsed) => factoryFor(parsed as string),
    },
  };
}

/** Build a stable tree {@link VizExample} that RUNS a BST algorithm (#3220) via the TracedTree. `seed`
 *  decides whether the tree starts empty (insert builds it) or finished (in-order walks it). */
function treeExampleFromProgram(program: TreeProgram): VizExample {
  const factoryFor = (values: number[]) =>
    runTreeAlgorithm((t) => program.run(t, values), program.seed(values));
  return {
    factory: factoryFor(program.defaultInput),
    renderers: { tree: TreeView },
    input: {
      default: treeToText(program.defaultInput),
      hint: "Whole numbers to insert, comma-separated (e.g. 50, 30, 70)",
      parse: (text) => parseTreeInput(text),
      make: async (parsed) => factoryFor(parsed as number[]),
    },
  };
}

/** Build a stable graph {@link VizExample} that RUNS a traversal / shortest-path algorithm (#3224) via the
 *  TracedGraph, with an adjacency-list "your input" seam. */
function graphExampleFromProgram(program: GraphProgram): VizExample {
  return {
    factory: runGraphAlgorithm(program.run, program.defaultInput),
    renderers: { graph: GraphView },
    input: {
      default: graphToText(program.defaultInput),
      hint: "An adjacency list — one node per line: a: b, c",
      parse: (text) => parseGraphInput(text),
      make: async (parsed) => runGraphAlgorithm(program.run, parsed as GraphInput),
    },
  };
}

/** Every per-structure renderer, so any panel a scene declares (graph / array / matrix / stack / scalar /
 *  tree) resolves. Shared by the in-app scene builder AND the stored-`vizCode` `scene` seam (#3275), so an
 *  in-app scene and a persisted-data one render identically. */
const SCENE_RENDERERS: RendererRegistry = {
  array: ArrayView,
  matrix: MatrixView,
  graph: GraphView,
  stack: StackView,
  scalar: ScalarView,
  tree: TreeView,
};

/** Build a stable MULTI-STRUCTURE {@link VizExample} (#3259) — runs a scene program via `runScene`, so its
 *  synchronized panels lay out side by side. Every per-structure renderer is registered so any panel the
 *  scene declares (graph / array / matrix / stack / scalar / tree) resolves. Each scene carries its OWN
 *  input seam (#3284), so the "your input" field edits whatever the scene seeds on (a graph, a number
 *  array, …). */
function sceneExampleFromProgram(program: SceneProgram): VizExample {
  return {
    factory: runScene(program.run, program.seed.default),
    renderers: SCENE_RENDERERS,
    input: {
      default: program.seed.serialize(program.seed.default),
      hint: program.seed.hint,
      parse: program.seed.parse,
      make: async (parsed) => runScene(program.run, parsed),
    },
  };
}

/** One VizExample per trace-program (array sorts + array searches + scalar accumulates + matrix transforms
 *  + graph traversals + multi-structure SCENES), built ONCE so each algorithm has a STABLE example identity
 *  — a fresh build per render would rebuild the player's stream every frame. Keyed by base name; each
 *  datatype contributes its own programs + renderer. SCENES are merged LAST, so a scene supersedes a
 *  single-structure program of the same name (e.g. `dijkstra` upgrades from a lone graph to graph +
 *  distance panels, #3259). */
const EXAMPLE_BY_KEY: Record<string, VizExample> = {
  ...Object.fromEntries(
    Object.entries(TRACE_PROGRAMS).map(([key, program]): [string, VizExample] => [key, exampleFromProgram(program)]),
  ),
  ...Object.fromEntries(
    Object.entries(SEARCH_PROGRAMS).map(([key, program]): [string, VizExample] => [key, searchExampleFromProgram(program)]),
  ),
  ...Object.fromEntries(
    Object.entries(SCALAR_PROGRAMS).map(([key, program]): [string, VizExample] => [key, scalarExampleFromProgram(program)]),
  ),
  ...Object.fromEntries(
    Object.entries(MATRIX_PROGRAMS).map(([key, program]): [string, VizExample] => [key, matrixExampleFromProgram(program)]),
  ),
  ...Object.fromEntries(
    Object.entries(GRAPH_PROGRAMS).map(([key, program]): [string, VizExample] => [key, graphExampleFromProgram(program)]),
  ),
  ...Object.fromEntries(
    Object.entries(STACK_PROGRAMS).map(([key, program]): [string, VizExample] => [key, stackExampleFromProgram(program)]),
  ),
  ...Object.fromEntries(
    Object.entries(TREE_PROGRAMS).map(([key, program]): [string, VizExample] => [key, treeExampleFromProgram(program)]),
  ),
  ...Object.fromEntries(
    Object.entries(SCENE_PROGRAMS).map(([key, program]): [string, VizExample] => [key, sceneExampleFromProgram(program)]),
  ),
};

/** Resolve an implementation's kind (#3210): the CREATOR-assigned `kind` wins; otherwise the heuristic
 *  classifier infers it. Retained for the datatype-renderer pick + `bsc graph doctor` (the viz TRACE now
 *  comes from the program, not the kind). `null` when neither yields a kind. */
export function resolveKind(impl: Pick<AlgoImpl, "kind"> & Classifiable): AlgoKind | null {
  return impl.kind ?? classifyKind(impl);
}

/** The per-datatype renderer + input seam for a sandbox-run stored program. Keeps `buildVizExampleFromCode`
 *  declarative; mirrors the in-app builders' choices so a stored program and an equivalent in-app one render
 *  identically. */
const DATATYPE_SEAM = {
  array: {
    renderers: { array: ArrayView } as RendererRegistry,
    hint: "Comma- or space-separated numbers",
    serialize: (input: VizRun["input"]) => (input as number[]).join(", "),
    parse: (text: string) => parseSortInput(text),
  },
  matrix: {
    renderers: { matrix: MatrixView } as RendererRegistry,
    hint: "A square grid — cells by comma/space, rows by ';' (e.g. 1,2 ; 3,4)",
    serialize: (input: VizRun["input"]) => matrixToText(input as number[][]),
    parse: (text: string) => parseMatrixInput(text),
  },
  graph: {
    renderers: { graph: GraphView } as RendererRegistry,
    hint: "An adjacency list — one node per line: a: b, c",
    serialize: (input: VizRun["input"]) => graphToText(input as GraphInput),
    parse: (text: string) => parseGraphInput(text),
  },
  // #4162 — the three renderers a stored program could not reach. Each reuses the family's own seam, so a
  // stored program and its in-app twin take the same text and animate the same way.
  tree: {
    renderers: { tree: TreeView } as RendererRegistry,
    hint: "Whole numbers to insert, comma-separated (e.g. 50, 30, 70)",
    serialize: (input: VizRun["input"]) => treeToText(input as number[]),
    parse: (text: string) => parseTreeInput(text),
  },
  stack: {
    // The parse is only a non-blank check by necessity — each stack program reads its OWN language
    // (brackets vs RPN), so a shared parser could validate nothing more (see `parseStackText`).
    renderers: { stack: StackView } as RendererRegistry,
    hint: "The expression to trace (e.g. ([]{}) or 3 4 + 2 *)",
    serialize: (input: VizRun["input"]) => stackToText(input as string),
    parse: (text: string) => parseStackText(text),
  },
  scalar: {
    renderers: { scalar: ScalarView } as RendererRegistry,
    hint: "The initial variables as name=value pairs (e.g. n=10)",
    serialize: (input: VizRun["input"]) => scalarSeedToText(input as Record<string, number | string>),
    parse: (text: string) => parseScalarSeed(text),
  },
  // A stored SCENE (#3275): every renderer registered (its panels can be any structure); seeds on a graph.
  scene: {
    renderers: SCENE_RENDERERS,
    hint: "An adjacency list — one node per line: a: b, c",
    serialize: (input: VizRun["input"]) => graphToText(input as GraphInput),
    parse: (text: string) => parseGraphInput(text),
  },
} as const;

/** Build a {@link VizExample} from a sandbox {@link VizRun} of a stored `vizCode` (#3233). The default
 *  factory REPLAYS the Worker-computed frames; the "your input" `make` re-runs the SAME code in the sandbox
 *  on the user's input (async). */
function buildVizExampleFromCode(code: string, run: VizRun): VizExample {
  const seam = DATATYPE_SEAM[run.datatype];
  return {
    factory: replay(run.frames),
    renderers: seam.renderers,
    // The run reports the exact source its frame `loc`s index into (#3250) — never `code`, which may
    // differ from it by leading/trailing whitespace and would shift every highlight.
    source: run.source,
    input: {
      default: seam.serialize(run.input),
      hint: seam.hint,
      parse: seam.parse,
      make: async (parsed) => replay((await runInSandbox(code, parsed)).frames),
    },
  };
}

/** Compiled stored-`vizCode` examples, cached BY CODE STRING as a Promise (#3233) — one sandbox run per
 *  distinct program, and a STABLE resolved example across renders (a fresh build would rebuild the player's
 *  stream). A malformed / timed-out program resolves to `undefined` (logged), so the caller falls back to
 *  the in-app program rather than a broken/blank pane. */
const CODE_EXAMPLE_CACHE = new Map<string, Promise<VizExample | undefined>>();

/** Resolve an impl's STORED `vizCode` into a {@link VizExample} by running it in the sandbox Worker (#3233)
 *  — the persisted-data counterpart of the in-app programs. `undefined` when the code is malformed, throws,
 *  or times out. Cached by code string. */
export function resolveVizExample(vizCode: string): Promise<VizExample | undefined> {
  let p = CODE_EXAMPLE_CACHE.get(vizCode);
  if (!p) {
    p = runInSandbox(vizCode)
      .then((run) => buildVizExampleFromCode(vizCode, run))
      .catch((err: unknown) => {
        console.warn(`[algorithms] stored vizCode ignored — ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      });
    CODE_EXAMPLE_CACHE.set(vizCode, p);
  }
  return p;
}

/** An implementation's IN-APP trace-program visualization (#3216), or `undefined` when it has none. Resolves
 *  synchronously (the program runs on the main thread — it is trusted app code). A stored `vizCode` is
 *  layered on top asynchronously by {@link useVizForImpl} (it runs in the sandbox Worker). Keyed by base
 *  name, so the named sort family + matrix/graph algorithms animate from real code, each distinctly. */
export function programVizForImpl(impl: { id: string; name?: string }): VizExample | undefined {
  return EXAMPLE_BY_KEY[programKey(impl)];
}
