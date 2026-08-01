// The stored-`vizCode` executor (#3232, epic #3215 slice B / #3230 §1) — compile an implementation's
// PERSISTED trace-program (its `vizCode` facet, #3218) into a runnable program descriptor. This is the
// "visualization as DATA" path: instead of a hardcoded in-app module (sorts.ts / matrixTransforms.ts /
// graphAlgos.ts), the algorithm's visualization lives in the store and is compiled here on demand.
//
// CONTRACT — `vizCode` is a JS expression that evaluates to a self-describing descriptor:
//
//   ({
//     datatype: "array",         // the structure — picks the runner + renderer(s) + input seam
//     input: [5, 2, 9, 1, 6],    // the DEFAULT input, shaped per datatype (see below)
//     run(a) { … },              // the real algorithm, written against the Traced<Structure> API
//   })
//
// DATATYPES — one per shipped renderer, each with its own input shape:
//
//   array   number[]                        run(array)
//   matrix  number[][]                      run(matrix)
//   graph   { nodes, edges }                run(graph)
//   tree    number[] (the values)           run(tree, values)   + optional seed(values) => TreeNode[]
//   stack   string (the expression)         run(stack, input)   + optional mode: "stack" | "queue"
//   scalar  { name: number|string }         run(scalar)
//   scene   { nodes, edges } (seed graph)   run(scene, input)
//
// A `"scene"` (#3275) is the MULTI-STRUCTURE case: its `run(scene, input)` drives a `TracedScene`
// (`scene.graph("g", …)` / `scene.array("dist", …)` / …), and it renders as synchronized panels — the
// persisted-data twin of the in-app scene programs (`scenes.ts`). It seeds on a GraphInput (like the graph
// datatype) and every structure renderer is registered so any panel it declares resolves.
//
// `tree`, `stack` and `scalar` (#4162) close the gap where three of the six shipped renderers were
// reachable ONLY from an in-app program: `TracedTree`/`TracedStack`/`TracedScalar` and their views all
// ship, `treeAlgos.ts`/`stackAlgos.ts`/`scalarAlgos.ts` drive them, but a STORED program naming one threw
// at compile — so bst-insert, bst-inorder, balanced-parens and postfix-eval could not be authored as data
// at all. Their descriptors carry the two extra fields the in-app `TreeProgram`/`StackProgram` interfaces
// already prove are load-bearing: a tree's `seed` (build-from-empty vs walk-a-finished-tree — without it,
// an in-order traversal replays the whole build as part of the walk) and a stack's `mode` (LIFO vs FIFO).
// Both are OPTIONAL, so the simple case stays a three-field descriptor.
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
  runTreeAlgorithm,
  runStackAlgorithm,
  runScalarAlgorithm,
  runScene,
  withSourceLoc,
  type GraphInput,
  type StackMode,
  type TracedArray,
  type TracedMatrix,
  type TracedGraph,
  type TracedTree,
  type TracedStack,
  type TracedScalar,
  type TracedScene,
  type TreeNode,
} from "../../lib/tracer";
import type { Frame } from "../../lib/trace";
import { instrumentVizCode, LOC_HOOK } from "./vizInstrument";

/** The structure a stored trace-program drives — selects the runner, renderer(s), and input seam. One per
 *  shipped renderer (#4162): `scene` is the multi-structure case (`run(scene, input)` over a TracedScene →
 *  synchronized panels); the rest each drive their single `Traced<Structure>`. */
export type VizDatatype = "array" | "matrix" | "graph" | "tree" | "stack" | "scalar" | "scene";

/** Every datatype, as data — the single list `compileVizProgram`'s validation, the error message, and the
 *  tests all read, so adding a datatype cannot leave one of them behind. */
export const VIZ_DATATYPES: readonly VizDatatype[] = [
  "array",
  "matrix",
  "graph",
  "tree",
  "stack",
  "scalar",
  "scene",
] as const;

/** A stored program's default input, per datatype — see the DATATYPES table at the top of this file. */
export type VizInput = number[] | number[][] | GraphInput | string | Record<string, number | string>;

/** A compiled, validated stored trace-program. `run` is typed per {@link datatype} by the caller (a
 *  `(structure) => void` over the matching Traced class, or a scene's `(scene, input) => void`); `input`
 *  is the datatype's default. */
export interface VizProgramDescriptor {
  datatype: VizDatatype;
  input: VizInput;
  /** `tree` only — the nodes the tree holds BEFORE `run` (`seed(values)`). Omitted ⇒ the tree starts empty
   *  and `run` builds it. This is what separates bst-insert (builds) from bst-inorder (walks a finished
   *  tree); without it the traversal's trace would replay the whole build first. */
  seed?: (values: number[]) => TreeNode[];
  /** `stack` only — LIFO (default) or FIFO. */
  mode?: StackMode;
  /** The exact source the program's frame {@link Frame.loc} ranges index into (#3250) — the TRIMMED
   *  `vizCode`, i.e. what was parsed and instrumented. Carried on the descriptor (rather than recomputed
   *  by the caller) so the code column always renders the string the offsets were measured against. */
  source: string;
  // The compiled algorithm. Loosely typed here (never-typed params are assignable to any Traced signature,
  // and a rest tuple lets a scene's TWO-arg `run(scene, input)` fit too); `runVizProgram` narrows it to the
  // datatype's real signature (`TracedArray|TracedMatrix|TracedGraph`, or `(TracedScene, GraphInput)`).
  run: (...args: never[]) => void;
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

/** True when `v` is a named-variable seed (the scalar-datatype input) — a plain object of numbers/strings.
 *  An EMPTY object is valid: an algorithm may set every variable it uses (`{}` is the "no parameters" seed). */
function isScalarSeed(v: unknown): v is Record<string, number | string> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(
    (x) => (typeof x === "number" && Number.isFinite(x)) || typeof x === "string",
  );
}

/** Does `input` match `datatype`'s declared shape? The gate that keeps a mismatched program from rendering
 *  an empty pane instead of failing. `tree` seeds on the VALUES (a `number[]`, like `array`) — the datatype
 *  names itself, so two structures sharing an input shape is not an ambiguity to resolve. */
function inputMatches(datatype: VizDatatype, input: unknown): boolean {
  switch (datatype) {
    case "array":
    case "tree":
      return isNumberArray(input);
    case "matrix":
      return isNumberGrid(input);
    case "graph":
    case "scene": // a scene seeds on a graph
      return isGraphInput(input);
    case "stack":
      return typeof input === "string";
    case "scalar":
      return isScalarSeed(input);
  }
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

  // Tag each traced call with its source range (#3250) so the frames it emits know where they came from.
  // Pure insertion over `trimmed`, so the recorded ranges index `trimmed` — the string reported as
  // `source` and rendered by the code column. An un-instrumentable program comes back unchanged with no
  // ranges: it still compiles and animates, just without highlighting.
  const { code: instrumented, locs } = instrumentVizCode(trimmed);

  let raw: unknown;
  try {
    // Strict mode; the ONLY injected binding is the location hook, a closure we own that pushes a range
    // onto the tracer's ambient stack for the duration of one traced call. It grants the program no
    // capability it did not already have (it can neither read nor reach anything through it), so the
    // isolation note above (#3233) still holds: the program's only capability is the Traced structure.
    const hook = <T,>(id: number, call: () => T): T => withSourceLoc(locs[id], call);
    raw = new Function(LOC_HOOK, `"use strict"; return (${instrumented});`)(hook);
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

  const datatype = d.datatype as VizDatatype;
  if (!VIZ_DATATYPES.includes(datatype)) {
    throw new Error(
      `vizCode.datatype must be ${VIZ_DATATYPES.map((t) => `"${t}"`).join(" | ")} (got ${JSON.stringify(d.datatype)})`,
    );
  }
  if (typeof d.run !== "function") {
    throw new Error("vizCode.run must be a function over the Traced structure");
  }

  const input = d.input;
  if (!inputMatches(datatype, input)) {
    throw new Error(`vizCode.input does not match datatype "${datatype}" (expected ${INPUT_SHAPE[datatype]})`);
  }
  // The two OPTIONAL per-datatype fields. A wrong TYPE is rejected rather than ignored: a `seed` that is
  // not a function, or a `mode` outside the two the tracer knows, is a program that does not do what its
  // author wrote — and silently dropping it would animate the wrong thing with no complaint.
  if (d.seed !== undefined && typeof d.seed !== "function") {
    throw new Error('vizCode.seed must be a function (values) => TreeNode[] — the tree\'s starting nodes');
  }
  if (d.mode !== undefined && d.mode !== "stack" && d.mode !== "queue") {
    throw new Error(`vizCode.mode must be "stack" | "queue" (got ${JSON.stringify(d.mode)})`);
  }

  return {
    datatype,
    input: input as VizInput,
    run: d.run as VizProgramDescriptor["run"],
    seed: d.seed as VizProgramDescriptor["seed"],
    mode: d.mode as StackMode | undefined,
    source: trimmed,
  };
}

/** Human-readable expected input shape per datatype, for the validation error message. */
const INPUT_SHAPE: Record<VizDatatype, string> = {
  array: "a number[]",
  matrix: "a number[][]",
  graph: "a { nodes, edges } object",
  tree: "a number[] (the values, in insertion order)",
  stack: "a string (the expression to trace)",
  scalar: "a { name: number | string } object (the initial variables)",
  scene: "a { nodes, edges } object (the scene's seed graph)",
};

/** The result of running a stored trace-program: its datatype, the input it ran on (the descriptor default
 *  or a caller override), and the recorded frame trace. Frames are plain, structured-cloneable data — so
 *  the Web Worker (#3233) posts them straight back to the main thread for replay. */
export interface VizRun {
  datatype: VizDatatype;
  input: VizInput;
  frames: Frame[];
  /** The trace-program source each frame's `loc` indexes into (#3250) — the trimmed `vizCode`. Travels
   *  back from the Worker alongside the frames so the code column and the highlights are always the same
   *  artifact; a caller must never substitute its own copy of the code. */
  source: string;
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
  // A caller-supplied override skipped `compileVizProgram`'s shape check, so it is validated here — the
  // "your input" seam parses text and could hand back a shape the descriptor's runner cannot accept.
  if (!inputMatches(d.datatype, input)) {
    throw new Error(`input does not match datatype "${d.datatype}" (expected ${INPUT_SHAPE[d.datatype]})`);
  }
  return { datatype: d.datatype, input, frames: [...framesFor(d, input)], source: d.source };
}

/** Run a compiled descriptor against its datatype's tracer. Split out of {@link runVizProgram} so the
 *  dispatch is one exhaustive `switch` (a new datatype fails to compile until it is handled) rather than a
 *  ternary chain whose final `else` silently absorbs anything unmatched. */
function framesFor(d: VizProgramDescriptor, input: VizRun["input"]): Generator<Frame> {
  switch (d.datatype) {
    case "array":
      return runAlgorithm(d.run as (a: TracedArray) => void, input as number[])();
    case "matrix":
      return runMatrixAlgorithm(d.run as (m: TracedMatrix) => void, input as number[][])();
    case "graph":
      return runGraphAlgorithm(d.run as (g: TracedGraph) => void, input as GraphInput)();
    case "tree": {
      // `run` takes the VALUES alongside the tree (matching the in-app `TreeProgram`): a build walks them,
      // and a traversal of a seeded tree simply ignores them.
      const values = input as number[];
      const run = d.run as unknown as (t: TracedTree, values: number[]) => void;
      return runTreeAlgorithm((t) => run(t, values), d.seed?.(values) ?? [])();
    }
    case "stack": {
      const text = input as string;
      const run = d.run as unknown as (s: TracedStack, input: string) => void;
      return runStackAlgorithm((s) => run(s, text), d.mode ?? "stack")();
    }
    case "scalar":
      return runScalarAlgorithm(
        d.run as (s: TracedScalar) => void,
        input as Record<string, number | string>,
      )();
    case "scene":
      return runScene(d.run as (scene: TracedScene, input: GraphInput) => void, input as GraphInput)();
  }
}
