// Source instrumentation for stored trace-programs (#3250, epic #3230/#3215) — the compile-time step that
// gives every emitted op a SOURCE LOCATION, so the animation can light up the line that is executing.
//
// WHY AST, NOT TEXT SEARCH. The viz philosophy is instrumented execution: real code runs and the frames
// ARE its ops. Per-op highlighting only holds up if each op knows which CALL produced it. A text search
// for `.swap(` cannot tell quicksort's two swap branches apart — it would find both and have to guess,
// and the highlight would jump to the wrong branch for half the trace. Parsing gives each call its exact,
// unambiguous range, so a repeated op always points at the call that actually ran.
//
// WHY NOT A RUNTIME STACK CAPTURE. The obvious no-dependency alternative is for the tracer to read
// `new Error().stack` on every emit. It was rejected: stack-string formats and the line offset that
// `new Function` introduces are ENGINE-SPECIFIC (V8 / JSC / SpiderMonkey all differ), so the feature would
// silently produce wrong ranges on some platforms and right ones on others — the worst failure mode for a
// teaching visualization. Parsing is deterministic on every engine.
//
// HOW. Each traced call `a.swap(i, j)` is rewritten to `__bscLoc(7, () => a.swap(i, j))`, where the hook
// pushes range #7 onto the tracer's ambient location stack for the duration of the call (`withSourceLoc`).
// Rewriting is pure INSERTION — no original character is moved or deleted — and the recorded ranges index
// the ORIGINAL source, which is also the string the code column renders. So the highlight and the code can
// never drift apart.

import { parse } from "acorn";
import type { SourceRange } from "../../lib/trace";
import { TracedArray, TracedGraph, TracedMatrix, TracedScalar, TracedScene, TracedStack, TracedTree } from "../../lib/tracer";

/** The identifier the instrumented program calls to announce its current source range. Deliberately
 *  unlikely to collide with anything a trace-program declares. */
export const LOC_HOOK = "__bscLoc";

/** Every method name the traced structures expose — DERIVED from the classes themselves rather than
 *  hand-listed, so a new tracer verb is instrumented the day it lands and this file never drifts.
 *
 *  Over-matching is harmless BY CONSTRUCTION: wrapping a call that emits no frame (`a.get(i)`, or an
 *  unrelated `list.push(x)` that merely shares a name with a tracer verb) just pushes and pops a range
 *  nobody reads. Under-matching would silently drop a highlight, so erring wide is the safe direction. */
const TRACER_METHODS: ReadonlySet<string> = new Set(
  [TracedArray, TracedMatrix, TracedGraph, TracedStack, TracedScalar, TracedTree, TracedScene]
    .flatMap((cls) => Object.getOwnPropertyNames(cls.prototype))
    .filter((name) => name !== "constructor"),
);

/** The shape of an acorn node this module reads. Acorn's own types are structural and loose; this is the
 *  minimal surface (`type` + offsets + the `loc` acorn adds under `locations: true`). */
interface AcornNode {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number } };
  [key: string]: unknown;
}

/** One instrumented call site: its range in the ORIGINAL source, plus the nested calls inside it. */
interface Hit extends SourceRange {
  id: number;
  children: Hit[];
}

/** The result of instrumenting a trace-program. */
export interface InstrumentedProgram {
  /** The rewritten program — the ORIGINAL source with `__bscLoc(id, () => …)` wrappers inserted. */
  code: string;
  /** The source ranges, indexed by the id the wrappers pass. Empty when nothing was instrumented. */
  locs: SourceRange[];
}

/** Depth-first walk of an acorn AST, visiting every node. Generic over the node shape (acorn nodes are
 *  plain objects), so it needs no per-node-type knowledge and cannot fall behind new syntax. */
function walk(node: unknown, visit: (n: AcornNode) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as Record<string, unknown>;
  if (typeof n.type === "string") visit(n as unknown as AcornNode);
  for (const key of Object.keys(n)) {
    // `loc`/`range` are acorn's position metadata, not child nodes — skip (they carry no `type`, so
    // walking them is merely wasted work, but the tree is hot enough to be worth not doing).
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    walk(n[key], visit);
  }
}

/** Is this call a traced-structure operation — `<expr>.<tracerMethod>(…)` with a literal method name? */
function isTracerCall(n: AcornNode): boolean {
  if (n.type !== "CallExpression") return false;
  const callee = n.callee as AcornNode | undefined;
  if (!callee || callee.type !== "MemberExpression" || callee.computed === true) return false;
  const prop = callee.property as AcornNode | undefined;
  return prop?.type === "Identifier" && TRACER_METHODS.has(prop.name as string);
}

/**
 * Rewrite a trace-program so each traced call announces its source range (#3250).
 *
 * @param source the trace-program source — the exact string whose offsets the returned ranges index, and
 *   the string the code column must render.
 * @returns the instrumented {@link InstrumentedProgram}. Falls back to the source UNCHANGED with no ranges
 *   when the program cannot be safely instrumented — it does not parse (the caller's `new Function` will
 *   report the syntax error with a better message), or it contains `await`/`yield`, which the arrow-function
 *   wrappers would change the meaning of. Degrading to "animates, but no highlighting" is deliberate: a
 *   visualization must never be lost to a highlighting feature.
 */
export function instrumentVizCode(source: string): InstrumentedProgram {
  const plain: InstrumentedProgram = { code: source, locs: [] };

  let ast: unknown;
  try {
    ast = parse(source, { ecmaVersion: "latest", locations: true });
  } catch {
    return plain; // not parseable — let the caller's compile step surface the real syntax error
  }

  const flat: Hit[] = [];
  let unsafe = false;
  walk(ast, (n) => {
    // An arrow wrapper would sever `await`/`yield` from their function, so a program using either is left
    // alone entirely. Trace-programs are synchronous by contract (`runAlgorithm` calls `run` and reads the
    // log immediately), so this is a guard, not a supported path.
    if (n.type === "AwaitExpression" || n.type === "YieldExpression") unsafe = true;
    if (isTracerCall(n)) {
      flat.push({ id: 0, start: n.start, end: n.end, line: n.loc?.start.line ?? 1, children: [] });
    }
  });
  if (unsafe || flat.length === 0) return plain;

  // Outermost-first, then by position: the ordering that lets one linear pass rebuild the containment
  // tree. AST call ranges are always properly nested (never partially overlapping), so a stack suffices.
  flat.sort((a, b) => a.start - b.start || b.end - a.end);
  flat.forEach((h, i) => (h.id = i));

  const roots: Hit[] = [];
  const stack: Hit[] = [];
  for (const hit of flat) {
    while (stack.length > 0 && stack[stack.length - 1].end <= hit.start) stack.pop();
    (stack[stack.length - 1]?.children ?? roots).push(hit);
    stack.push(hit);
  }

  // Rebuild the source recursively rather than splicing offsets in place: nested calls make offset
  // bookkeeping error-prone (wrapping an inner call shifts the outer call's end), whereas rendering each
  // range from its children is correct by construction.
  const render = (from: number, to: number, children: Hit[]): string => {
    let out = "";
    let cursor = from;
    for (const child of children) {
      out += source.slice(cursor, child.start);
      out += `${LOC_HOOK}(${child.id},()=>${render(child.start, child.end, child.children)})`;
      cursor = child.end;
    }
    return out + source.slice(cursor, to);
  };

  return {
    code: render(0, source.length, roots),
    locs: flat.map(({ start, end, line }) => ({ start, end, line })),
  };
}
