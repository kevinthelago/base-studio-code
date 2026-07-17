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
// TRUST + ISOLATION (#3233): `vizCode` reaches the store ONLY via the packaged seed or the role-gated
// `bsc graph impl set --viz-code` — both trusted, exactly as trusted as the in-app trace-programs that
// already execute on the main thread. The Studio share/apply path does NOT carry the algorithms graph
// today (TODO #2889). So compiling with `new Function` on the main thread matches the current trust model.
// When #2889 makes the graph Studio-importable (untrusted `vizCode`), execution must move into a Web
// Worker / iframe sandbox — this module is the deliberately-isolated seam for that swap (#3233).

import type { GraphInput } from "../../lib/tracer";

/** The structure a stored trace-program drives — selects the runner, renderer, and input seam. */
export type VizDatatype = "array" | "matrix" | "graph";

/** A compiled, validated stored trace-program. `run` is typed per {@link datatype} by the caller (it is a
 *  `(structure) => void` written against the matching Traced class); `input` is the datatype's default. */
export interface VizProgramDescriptor {
  datatype: VizDatatype;
  input: number[] | number[][] | GraphInput;
  // The compiled algorithm. Loosely typed here (a bottom-typed param is assignable to any Traced class);
  // `vizExampleFromCode` narrows it to the datatype's `TracedArray|TracedMatrix|TracedGraph` signature.
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
