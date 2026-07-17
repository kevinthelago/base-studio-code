// The stored-`vizCode` executor (#3232, epic #3215 slice B / #3230 §1) — compile an implementation's
// PERSISTED trace-program (its `vizCode` facet, #3218) into a runnable program descriptor. This is the
// "visualization as DATA" path: instead of a hardcoded in-app module (sorts.ts / matrixTransforms.ts /
// graphAlgos.ts), the algorithm's visualization lives in the store and is compiled here on demand.
//
// CONTRACT — `vizCode` is a JS expression that evaluates to a self-describing descriptor:
//
//   ({
//     datatype: "array",         // "array" | "matrix" | "graph" — picks the runner + renderer + input seam
//     input: [5, 2, 9, 1, 6],    // the DEFAULT input (number[] | number[][] | GraphInput)
//     run(a) { … },              // the real algorithm, written against the Traced<Structure> API
//   })
//
// It is self-contained (carries its own default input so the preview + "your input" field work) and does
// NOT depend on `kind` — the descriptor names its own datatype, so nothing is inferred or guessed.
//
// ISOLATION (#3233): this module is PURE (compile + run over the tracer, no DOM). It is imported by the
// dedicated Web Worker (`vizWorker.ts`) so `compileVizProgram`'s `new Function` and the algorithm's `run`
// execute in the WORKER's isolated global scope — never on the main thread, and never with DOM access. The
// main thread reaches it only through `vizSandbox.runInSandbox` (which posts to the worker); it also imports
// it directly as the inline fallback when `Worker` is unavailable (test / SSR), where trusted test code runs
// it on the main thread. A runaway program (e.g. `while(true)`) wedges only the worker, which the sandbox
// terminates on timeout — the main thread never freezes.

import {
  runAlgorithm,
  runMatrixAlgorithm,
  runGraphAlgorithm,
  type GraphInput,
  type TracedArray,
  type TracedMatrix,
  type TracedGraph,
} from "../../lib/tracer";
import type { Frame } from "../../lib/trace";

/** The structure a stored trace-program drives — selects the runner, renderer, and input seam. */
export type VizDatatype = "array" | "matrix" | "graph";

/** A compiled, validated stored trace-program. `run` is typed per {@link datatype} by the caller (it is a
 *  `(structure) => void` written against the matching Traced class); `input` is the datatype's default. */
export interface VizProgramDescriptor {
  datatype: VizDatatype;
  input: number[] | number[][] | GraphInput;
  // The compiled algorithm. Loosely typed here (a bottom-typed param is assignable to any Traced class);
  // `runVizProgram` narrows it to the datatype's `TracedArray|TracedMatrix|TracedGraph` signature.
  run: (structure: never) => void;
}

/** True when `v` is a finite-number array (the array-datatype default input). */
function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

/** True when `v` is a rectangular-ish grid of finite numbers (the matrix-datatype default input). */
function isNumberGrid(v: unknown): v is number[][] {
  return Array.isArray(v) && v.length > 0 && v.every(isNumberArray);
}

/** True when `v` has the {@link GraphInput} shape — `nodes` + `edges` arrays (the graph-datatype input). */
function isGraphInput(v: unknown): v is GraphInput {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return Array.isArray(g.nodes) && Array.isArray(g.edges);
}

/**
 * Compile a stored `vizCode` string into a validated {@link VizProgramDescriptor}.
 *
 * @param code the impl's `vizCode` — a JS expression evaluating to `{ datatype, input, run }`.
 * @returns the validated descriptor.
 * @throws Error with a human-readable reason when the code is empty, fails to evaluate, is not a
 *   descriptor object, names an unknown `datatype`, lacks a `run` function, or carries an `input` whose
 *   shape does not match `datatype`. Callers catch this and fall back to the in-app program.
 */
export function compileVizProgram(code: string): VizProgramDescriptor {
  const trimmed = code?.trim();
  if (!trimmed) throw new Error("vizCode is empty");

  let raw: unknown;
  try {
    // Strict mode + no injected scope: the program's ONLY capability is the Traced structure the tracer
    // hands to run(); it cannot see this module's bindings. See the TRUST note above (#3233).
    raw = new Function(`"use strict"; return (${trimmed});`)();
  } catch (e) {
    // Preserve the original SyntaxError as `cause` (assigned, not via the ES2022 constructor option —
    // the tsconfig lib target is ES2020).
    const err = new Error(`vizCode failed to compile: ${(e as Error).message}`);
    (err as Error & { cause?: unknown }).cause = e;
    throw err;
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("vizCode must evaluate to a { datatype, input, run } object");
  }
  const d = raw as Record<string, unknown>;

  const datatype = d.datatype;
  if (datatype !== "array" && datatype !== "matrix" && datatype !== "graph") {
    throw new Error(`vizCode.datatype must be "array" | "matrix" | "graph" (got ${JSON.stringify(datatype)})`);
  }
  if (typeof d.run !== "function") {
    throw new Error("vizCode.run must be a function over the Traced structure");
  }

  const input = d.input;
  const ok =
    (datatype === "array" && isNumberArray(input)) ||
    (datatype === "matrix" && isNumberGrid(input)) ||
    (datatype === "graph" && isGraphInput(input));
  if (!ok) {
    throw new Error(`vizCode.input does not match datatype "${datatype}" (expected ${INPUT_SHAPE[datatype]})`);
  }

  return { datatype, input: input as VizProgramDescriptor["input"], run: d.run as VizProgramDescriptor["run"] };
}

/** Human-readable expected input shape per datatype, for the validation error message. */
const INPUT_SHAPE: Record<VizDatatype, string> = {
  array: "a number[]",
  matrix: "a number[][]",
  graph: "a { nodes, edges } object",
};

/** The result of running a stored trace-program: its datatype, the input it ran on (the descriptor default
 *  or a caller override), and the recorded frame trace. Frames are plain, structured-cloneable data — so
 *  the Web Worker (#3233) posts them straight back to the main thread for replay. */
export interface VizRun {
  datatype: VizDatatype;
  input: number[] | number[][] | GraphInput;
  frames: Frame[];
}

/**
 * Compile a stored `vizCode` and RUN it against the matching Traced structure, collecting the full frame
 * trace (#3233). Pure — this is the unit the Web Worker executes in isolation; the main thread calls it only
 * as the no-Worker fallback (tests / SSR).
 *
 * @param code the impl's `vizCode` — a `{ datatype, input, run }` descriptor expression.
 * @param inputOverride when set, runs the program on this input instead of the descriptor's default (the
 *   "your input" seam). Its shape is validated by the tracer for the descriptor's datatype.
 * @returns the datatype, the input used, and the recorded frames.
 * @throws whatever {@link compileVizProgram} throws (malformed code) or the algorithm throws at runtime.
 */
export function runVizProgram(code: string, inputOverride?: unknown): VizRun {
  const d = compileVizProgram(code);
  const input = (inputOverride ?? d.input) as VizRun["input"];
  const frames =
    d.datatype === "array"
      ? [...runAlgorithm(d.run as (a: TracedArray) => void, input as number[])()]
      : d.datatype === "matrix"
        ? [...runMatrixAlgorithm(d.run as (m: TracedMatrix) => void, input as number[][])()]
        : [...runGraphAlgorithm(d.run as (g: TracedGraph) => void, input as GraphInput)()];
  return { datatype: d.datatype, input, frames };
}
