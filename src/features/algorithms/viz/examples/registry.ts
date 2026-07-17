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
import {
  runAlgorithm,
  runMatrixAlgorithm,
  runGraphAlgorithm,
  type GraphInput,
  type TracedArray,
  type TracedMatrix,
  type TracedGraph,
} from "../../lib/tracer";
import { compileVizProgram } from "./vizProgram";
import type { RendererRegistry } from "../registry";
import { ArrayView } from "../renderers/ArrayView";
import { MatrixView } from "../renderers/MatrixView";
import { GraphView } from "../renderers/GraphView";
import { parseSortInput } from "./sort";
import { TRACE_PROGRAMS, programKey, type AlgoProgram } from "./sorts";
import { MATRIX_PROGRAMS, parseMatrixInput, matrixToText, type MatrixProgram } from "./matrixTransforms";
import { GRAPH_PROGRAMS, parseGraphInput, graphToText, type GraphProgram } from "./graphAlgos";

/** A ready-to-play visualization: a stable default factory (the inline preview) + the per-structure
 *  renderers the player dispatches to + an editable INPUT seam (#3199) that powers the "your input" field. */
export interface VizExample {
  /** A fresh trace generator from the default input. STABLE identity (built once per algorithm below), so
   *  the inspector hands it straight to `<TracePlayer factory>` without re-memoizing. */
  factory: () => Generator<Frame>;
  /** The renderers this example needs (array → {@link ArrayView}). */
  renderers: RendererRegistry;
  /** The editable input driving the trace (#3199) — `parse` turns the field text into typed input (throwing
   *  a helpful Error on invalid input); `make` RE-RUNS the program on it. `make(parse(default))` reproduces
   *  `factory`. The seam is `unknown` so the registry can hold mixed input shapes. */
  input: {
    default: string;
    hint: string;
    parse: (text: string) => unknown;
    make: (parsed: unknown) => Generator<Frame>;
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
      make: (parsed) => runAlgorithm(program.run, parsed as number[])(),
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
      make: (parsed) => runMatrixAlgorithm(program.run, parsed as number[][])(),
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
      make: (parsed) => runGraphAlgorithm(program.run, parsed as GraphInput)(),
    },
  };
}

/** One VizExample per trace-program (array sorts + matrix transforms + graph traversals), built ONCE so
 *  each algorithm has a STABLE example identity — a fresh build per render would rebuild the player's stream
 *  every frame. Keyed by base name; each datatype contributes its own programs + renderer. */
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
};

/** Resolve an implementation's kind (#3210): the CREATOR-assigned `kind` wins; otherwise the heuristic
 *  classifier infers it. Retained for the datatype-renderer pick + `bsc graph doctor` (the viz TRACE now
 *  comes from the program, not the kind). `null` when neither yields a kind. */
export function resolveKind(impl: Pick<AlgoImpl, "kind"> & Classifiable): AlgoKind | null {
  return impl.kind ?? classifyKind(impl);
}

/** Compiled stored-`vizCode` examples, cached BY CODE STRING (#3232). The cache gives the built example a
 *  STABLE identity across renders — vizForImpl is called every render, and a fresh compile each time would
 *  rebuild the player's frame stream every frame. A malformed program caches as `undefined` so a bad string
 *  neither recompiles-and-rethrows each render nor blanks a covered algorithm (it falls back to the program). */
const CODE_EXAMPLE_CACHE = new Map<string, VizExample | undefined>();

/** Build a {@link VizExample} from an impl's STORED `vizCode` (#3232) — the persisted-data counterpart of
 *  the in-app programs. Compiles + validates the descriptor, then dispatches by `datatype` to the same
 *  builder the in-app programs use. Returns `undefined` (and logs) when the code is malformed, so the caller
 *  falls back to the in-app program rather than showing a broken/blank pane. Cached by code string. */
export function vizExampleFromCode(vizCode: string): VizExample | undefined {
  if (CODE_EXAMPLE_CACHE.has(vizCode)) return CODE_EXAMPLE_CACHE.get(vizCode);

  let example: VizExample | undefined;
  try {
    const d = compileVizProgram(vizCode);
    switch (d.datatype) {
      case "array":
        example = exampleFromProgram({ run: d.run as (a: TracedArray) => void, defaultInput: d.input as number[] });
        break;
      case "matrix":
        example = matrixExampleFromProgram({ run: d.run as (m: TracedMatrix) => void, defaultInput: d.input as number[][] });
        break;
      case "graph":
        example = graphExampleFromProgram({ run: d.run as (g: TracedGraph) => void, defaultInput: d.input as GraphInput });
        break;
    }
  } catch (err) {
    console.warn(`[algorithms] stored vizCode ignored — ${(err as Error).message}`);
    example = undefined;
  }
  CODE_EXAMPLE_CACHE.set(vizCode, example);
  return example;
}

/** The visualization for an implementation — its STORED `vizCode` program (#3232) if present + valid, else
 *  its OWN in-app trace-program (#3216), else `undefined` (so the algorithm shows no animation, never a
 *  wrong one). Stored `vizCode` is the durable, per-algorithm form; the in-app programs (sort family, matrix
 *  transforms, graph traversals) are the SEED/reference and the fallback. A malformed `vizCode` falls through
 *  to the in-app program, so a bad string never blanks an algorithm that would otherwise animate. */
export function vizForImpl(impl: Pick<AlgoImpl, "id" | "name" | "vizCode">): VizExample | undefined {
  if (impl.vizCode && impl.vizCode.trim()) {
    const fromCode = vizExampleFromCode(impl.vizCode);
    if (fromCode) return fromCode;
  }
  return EXAMPLE_BY_KEY[programKey(impl)];
}
