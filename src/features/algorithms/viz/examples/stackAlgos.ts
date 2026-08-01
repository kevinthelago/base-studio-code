// STACK trace-programs (#3220, epic #3215) — the algorithms whose whole state IS the stack: the structure
// is not a container the algorithm happens to use, it is the thing being watched. Both are written over a
// TracedStack, so the animation is DERIVED from real execution — `push`/`pop` are the algorithm's own calls,
// not a replayed script.
//
// WHY THESE EXIST: `TracedStack`, `<StackView>`, its motion file and its tests all shipped with the tracer
// work, but the example registry only merged array/search/scalar/matrix/graph/scene programs — so a stack
// could only ever be MET inside a multi-structure scene (bfs's frontier, dijkstra's queue), never SELECTED
// as an algorithm in its own right. The renderer was finished and unreachable; these two programs are the
// keys that open it.
import type { TracedStack, StackMode } from "../../lib/tracer";

/**
 * A visualizable stack algorithm — its real logic over a {@link TracedStack}, plus its own input seam.
 *
 * The seam is PER-PROGRAM here, unlike the array/matrix/graph families which share one parser. That is not
 * an inconsistency to tidy away: the two stack algorithms read genuinely different input languages (a
 * bracket string vs an RPN expression), so a single family parser could only validate the intersection of
 * the two — which is "a non-empty string", i.e. no validation at all. Each program owning its parser is
 * what lets the field reject `3 4 &` with a real message instead of failing mid-trace.
 */
export interface StackProgram {
  run: (s: TracedStack, input: string) => void;
  /** The TracedStack mode to run under — both current programs are LIFO stacks. */
  mode: StackMode;
  defaultInput: string;
  /** Placeholder text shown under the "your input" field. */
  hint: string;
  /** Parse the field text into this program's input, throwing a helpful Error the field can show. */
  parse: (text: string) => string;
}

/** Openers → their matching closer. The single source of truth for both the scan and the validator. */
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set(Object.values(PAIRS));

/**
 * Are the brackets in `text` balanced? The canonical stack algorithm: every opener is PUSHED, every closer
 * POPS and must match the top. Returns the verdict; the trace is the point.
 *
 * An unbalanced input is a legitimate, interesting trace — a closer with an empty stack, or a mismatched
 * pair, ends the scan early and leaves the animation sitting on the failure. Characters outside the bracket
 * alphabet are skipped silently, so `f(x[0])` traces the brackets and ignores the rest.
 */
export function balancedParens(s: TracedStack, input: string): boolean {
  for (const ch of input) {
    if (PAIRS[ch]) {
      s.push(ch);
      continue;
    }
    if (!CLOSERS.has(ch)) continue; // not a bracket — not this algorithm's business
    if (s.size === 0) return false; // a closer with nothing open
    const open = s.pop();
    if (typeof open !== "string" || PAIRS[open] !== ch) return false; // wrong pair
  }
  return s.size === 0; // anything still open ⇒ unbalanced
}

/** Reject anything that would trace to nothing, so the field explains itself before the animation runs. */
export function parseParensInput(text: string): string {
  const t = text.trim();
  if (t.length === 0) throw new Error("Enter a bracket expression, e.g. {[()()]}");
  if (t.length > 40) throw new Error("Keep it to 40 characters so the animation stays watchable");
  if (![...t].some((c) => PAIRS[c] || CLOSERS.has(c))) {
    throw new Error(`"${t}" has no brackets — try {[()()]}`);
  }
  return t;
}

const OPS: Record<string, (a: number, b: number) => number> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => (b === 0 ? 0 : a / b),
};

/**
 * Evaluate a postfix (RPN) expression — the other canonical stack algorithm, and the one that shows the
 * stack SHRINKING under an operator rather than just unwinding. Operands are pushed; each operator pops two
 * and pushes the result, so the final `pop` is the answer.
 *
 * `a` is popped SECOND (it is the deeper operand), which is what makes `-` and `/` come out the right way
 * round. Division by zero yields 0 rather than Infinity — the trace stays renderable, and RPN has no
 * meaningful error frame to show.
 */
export function postfixEval(s: TracedStack, input: string): number {
  for (const tok of input.trim().split(/\s+/)) {
    const op = OPS[tok];
    if (!op) {
      s.push(Number(tok));
      continue;
    }
    if (s.size < 2) return 0; // malformed — not enough operands
    const b = Number(s.pop());
    const a = Number(s.pop()); // deeper operand ⇒ the LEFT-hand side
    s.push(op(a, b));
  }
  return s.size ? Number(s.pop()) : 0;
}

/** Validate an RPN expression: numbers + the four operators, and enough operands to reduce to one value. */
export function parsePostfixInput(text: string): string {
  const t = text.trim();
  if (t.length === 0) throw new Error("Enter a postfix expression, e.g. 3 4 + 2 *");
  const toks = t.split(/\s+/);
  if (toks.length > 25) throw new Error("Keep it to 25 tokens so the animation stays watchable");
  let depth = 0;
  for (const tok of toks) {
    if (OPS[tok]) {
      depth -= 1; // pops two, pushes one
      if (depth < 1) throw new Error(`"${tok}" has no two operands before it`);
      continue;
    }
    if (!Number.isFinite(Number(tok))) throw new Error(`"${tok}" is not a number or one of + - * /`);
    depth += 1;
  }
  if (depth !== 1) throw new Error("Expression must reduce to exactly one value");
  return t;
}

/** The visualizable stack algorithms, keyed by base name (#3220). */
export const STACK_PROGRAMS: Record<string, StackProgram> = {
  "balanced-parens": {
    run: balancedParens,
    mode: "stack",
    defaultInput: "{[()()]}",
    hint: "A bracket expression (e.g. {[()()]})",
    parse: parseParensInput,
  },
  "postfix-eval": {
    run: postfixEval,
    mode: "stack",
    defaultInput: "3 4 + 2 *",
    hint: "A postfix expression, space-separated (e.g. 3 4 + 2 *)",
    parse: parsePostfixInput,
  },
};

/** Serialize a stack seed to the "your input" text form — the input already IS its text. */
export function stackToText(input: string): string {
  return input;
}

/**
 * Parse the "your input" text for a STORED stack program (#4162) — the generic seam, which can only check
 * that there is something to trace.
 *
 * This is the same reasoning that made {@link StackProgram} carry a per-program `parse`, applied to the
 * stored case: a shared parser could only ever validate the INTERSECTION of every stack language, and for
 * brackets vs RPN that intersection is "a non-empty string". A stored program's own validation lives inside
 * its `run`, which is the only place that knows which language it reads.
 *
 * @throws Error (shown under the field) when the text is blank.
 */
export function parseStackText(text: string): string {
  const t = text.trim();
  if (t.length === 0) throw new Error("Enter an expression to trace");
  return t;
}
