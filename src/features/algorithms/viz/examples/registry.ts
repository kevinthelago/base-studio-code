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
import { runAlgorithm, runMatrixAlgorithm, runGraphAlgorithm, runScene, type GraphInput } from "../../lib/tracer";
import { runInSandbox } from "./vizSandbox";
import type { VizRun } from "./vizProgram";
import type { RendererRegistry } from "../registry";
import { ArrayView } from "../renderers/ArrayView";
import { MatrixView } from "../renderers/MatrixView";
import { GraphView } from "../renderers/GraphView";
import { StackView } from "../renderers/StackView";
import { parseSortInput } from "./sort";
import { TRACE_PROGRAMS, programKey, type AlgoProgram } from "./sorts";
import { MATRIX_PROGRAMS, parseMatrixInput, matrixToText, type MatrixProgram } from "./matrixTransforms";
import { GRAPH_PROGRAMS, parseGraphInput, graphToText, type GraphProgram } from "./graphAlgos";
import { SCENE_PROGRAMS, type SceneProgram } from "./scenes";

/** A ready-to-play visualization: a stable default factory (the inline preview) + the per-structure
 *  renderers the player dispatches to + an editable INPUT seam (#3199) that powers the "your input" field. */
export interface VizExample {
  /** A fresh trace generator from the default input. STABLE identity (built once per algorithm below), so
   *  the inspector hands it straight to `<TracePlayer factory>` without re-memoizing. */
  factory: () => Generator<Frame>;
  /** The renderers this example needs (array → {@link ArrayView}). */
  renderers: RendererRegistry;
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

/** Build a stable MULTI-STRUCTURE {@link VizExample} (#3259) — runs a scene program via `runScene`, so its
 *  synchronized panels lay out side by side. All three per-structure renderers are registered so any panel
 *  the scene declares (graph / array / matrix) resolves. The "your input" seam edits the seed graph. */
function sceneExampleFromProgram(program: SceneProgram): VizExample {
  return {
    factory: runScene(program.run, program.defaultInput),
    renderers: { array: ArrayView, matrix: MatrixView, graph: GraphView, stack: StackView },
    input: {
      default: graphToText(program.defaultInput),
      hint: "An adjacency list — one node per line: a: b, c",
      parse: (text) => parseGraphInput(text),
      make: async (parsed) => runScene(program.run, parsed as GraphInput),
    },
  };
}

/** One VizExample per trace-program (array sorts + matrix transforms + graph traversals + multi-structure
 *  SCENES), built ONCE so each algorithm has a STABLE example identity — a fresh build per render would
 *  rebuild the player's stream every frame. Keyed by base name; each datatype contributes its own programs
 *  + renderer. SCENES are merged LAST, so a scene supersedes a single-structure program of the same name
 *  (e.g. `dijkstra` upgrades from a lone graph to graph + distance panels, #3259). */
const EXAMPLE_BY_KEY: Record<string, VizExample> = {
  ...Object.fromEntries(
    Object.entries(TRACE_PROGRAMS).map(([key, program]): [string, VizExample] => [key, exampleFromProgram(program)]),
  ),
  ...Object.fromEntries(
    Object.entries(MATRIX_PROGRAMS).map(([key, program]): [string, VizExample] => [key, matrixExampleFromProgram(program)]),
  ),
  ...Object.fromEntries(
    Object.entries(GRAPH_PROGRAMS).map(([key, program]): [string, VizExample] => [key, graphExampleFromProgram(program)]),
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
} as const;

/** Build a {@link VizExample} from a sandbox {@link VizRun} of a stored `vizCode` (#3233). The default
 *  factory REPLAYS the Worker-computed frames; the "your input" `make` re-runs the SAME code in the sandbox
 *  on the user's input (async). */
function buildVizExampleFromCode(code: string, run: VizRun): VizExample {
  const seam = DATATYPE_SEAM[run.datatype];
  return {
    factory: replay(run.frames),
    renderers: seam.renderers,
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
