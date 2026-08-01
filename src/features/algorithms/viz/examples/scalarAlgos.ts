// SCALAR / accumulate trace-programs (#3220, epic #3215) — the algorithms whose whole state is a handful
// of NAMED VARIABLES rather than a container: no array, no graph, just counters rolling forward. Fibonacci
// is the family's proof, and it is the shape the seeded `fibonacci.rs` / `fibonacci.ts` impls (two impls,
// ONE algorithm — both the iterative bottom-up form) already ship.
//
// Written over a TracedScalar, so the animation is DERIVED from the recurrence's real execution: the `add`
// verb IS `b += a` (the recurrence itself, as an accumulation), and the `set` verbs are the roll-forward.
// This is the first caller of `runScalarAlgorithm` — the `<ScalarView>` renderer previously only appeared
// as a scene panel.
import type { TracedScalar } from "../../lib/tracer";

/** A visualizable scalar algorithm — its real logic over a {@link TracedScalar} + the initial variable map
 *  to seed it (the algorithm reads its parameters straight out of that state). */
export interface ScalarProgram {
  run: (s: TracedScalar) => void;
  defaultInput: Record<string, number | string>;
}

/** The fibonacci seed — big enough that the accumulation visibly runs, small enough to stay watchable. */
const FIB_MOCK: Record<string, number | string> = { n: 10 };

/**
 * The nth Fibonacci number (0-indexed: F0 = 0, F1 = 1), iterated bottom-up — the same algorithm the seeded
 * `fibonacci.rs` / `fibonacci.ts` impls ship, expressed in the two-variable in-place form:
 *
 *   `b += a` (the recurrence, emitted as the `add` accumulate verb) then `a ←` the previous `b`.
 *
 * Reads `n` from the traced state; leaves the answer in `fib`. `n < 2` returns `n` immediately (F0 = 0,
 * F1 = 1), which is a legitimately short trace — the base case really is one step.
 */
export function fibonacci(s: TracedScalar): void {
  const n = Number(s.get("n") ?? 0);
  if (!Number.isFinite(n) || n < 2) {
    s.set("fib", Number.isFinite(n) ? Math.max(0, n) : 0);
    return;
  }
  s.set("a", 0); // F(i-2)
  s.set("b", 1); // F(i-1)
  for (let i = 2; i <= n; i++) {
    s.set("i", i);
    const a = Number(s.get("a"));
    const b = Number(s.get("b"));
    s.add("b", a); // b ← a + b — the recurrence, as an accumulation
    s.set("a", b); // a ← the previous b
  }
  s.set("fib", Number(s.get("b")));
}

/** The visualizable scalar algorithms, keyed by base name (#3220). */
export const SCALAR_PROGRAMS: Record<string, ScalarProgram> = {
  fibonacci: { run: fibonacci, defaultInput: FIB_MOCK },
};

/** Serialize a scalar seed to the "your input" text form — just `n` (the family's single parameter). */
export function scalarToText(input: Record<string, number | string>): string {
  return String(input.n ?? "");
}

/**
 * Serialize an ARBITRARY scalar seed to `name=value` pairs — the seam a STORED trace-program uses (#4162).
 *
 * Deliberately not {@link scalarToText}: that renders `input.n` alone, which is right for the in-app
 * fibonacci (whose single parameter IS n) and silently wrong for any other seed — a stored program seeded
 * `{ start: 3, limit: 9 }` would render an EMPTY field and parse back as `{ n }`, animating something its
 * author never wrote. A stored program can seed any variables, so its seam names them.
 */
export function scalarSeedToText(input: Record<string, number | string>): string {
  return Object.entries(input)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/**
 * Parse `name=value` pairs into a scalar seed — the generic counterpart to {@link scalarSeedToText}.
 * Numeric-looking values become numbers; everything else stays a string (a `TracedScalar` holds both).
 * An EMPTY seed is valid — an algorithm may set every variable it uses.
 *
 * @throws Error (shown under the "your input" field) when a pair has no `=` or an empty name.
 */
export function parseScalarSeed(text: string): Record<string, number | string> {
  const t = text.trim();
  if (t.length === 0) return {};
  const out: Record<string, number | string> = {};
  for (const part of t.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error(`"${part.trim()}" must be name=value (e.g. n=10)`);
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!name) throw new Error(`"${part.trim()}" has no variable name`);
    const num = Number(raw);
    out[name] = raw !== "" && Number.isFinite(num) ? num : raw;
  }
  return out;
}

/**
 * Parse the "your input" text into a scalar seed — a single non-negative integer `n`. Throws a helpful
 * `Error` (shown under the field) on empty, non-numeric, negative, fractional, or unwatchably-large input.
 */
export function parseScalarInput(text: string): Record<string, number | string> {
  const t = text.trim();
  if (t.length === 0) throw new Error("Enter n, e.g. 10");
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`"${t}" is not a number`);
  if (!Number.isInteger(n) || n < 0) throw new Error("n must be a whole number, 0 or greater");
  if (n > 40) throw new Error("Keep n at 40 or less so the animation stays watchable");
  return { n };
}
