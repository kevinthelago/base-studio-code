// previewDataset (#3439) — a SYNCHRONOUS, real dataset for a target STRUCTURE, sourced from a canonical
// in-app trace program (NOT the sandbox `vizCode` path — these programs are trusted app code that runs on
// the main thread). This is what lets the Design Studio's SHAPE tier feed a component that declares a
// `DataShape` with real algorithm-GENERATED data, with no per-component `PREVIEW_BINDINGS` row.
//
// Only the structures that have BOTH a `VizDataset` kind and registered programs are offered — `array`
// (the sorts) and `graph` (the traversals). `tree`/`matrix`/etc. are out of scope here (tree is #3790).
// Pure + deterministic (a fixed program + seed) so a preview never flickers between renders.
import { runAlgorithm, runGraphAlgorithm } from "../lib/tracer";
import { TRACE_PROGRAMS } from "./examples/sorts";
import { GRAPH_PROGRAMS } from "./examples/graphAlgos";
import { vizRunToDataset, type VizDataset } from "./vizDataset";

/** The structures the shape tier can source a real dataset for. */
export type PreviewStructure = "array" | "graph";

/**
 * A real, algorithm-GENERATED dataset for `structure` — the settled output of a canonical trace program
 * (a sorted array; a traversed graph), normalized to the shape a component preview binds to. `undefined`
 * only if no program is registered for the structure (never in practice). Deterministic: the first
 * registered program on its default seed, run on the main thread.
 */
export function datasetForStructure(structure: PreviewStructure): VizDataset | undefined {
  if (structure === "array") {
    const program = Object.values(TRACE_PROGRAMS)[0];
    if (!program) return undefined;
    const frames = [...runAlgorithm(program.run, program.defaultInput)()];
    return vizRunToDataset({ datatype: "array", input: [...program.defaultInput], frames, source: "" });
  }
  const program = Object.values(GRAPH_PROGRAMS)[0];
  if (!program) return undefined;
  const frames = [...runGraphAlgorithm(program.run, program.defaultInput)()];
  return vizRunToDataset({ datatype: "graph", input: program.defaultInput, frames, source: "" });
}
