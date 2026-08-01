// #3220 — the stack programs. `TracedStack` and `<StackView>` shipped with the tracer work but no program
// was ever registered for the `stack` structure, so the renderer was reachable only inside a scene. These
// cover the two algorithms that open it: the logic is right, and the FRAMES are the algorithm's own calls.
import { describe, it, expect } from "vitest";
import { TracedStack, runStackAlgorithm } from "../../lib/tracer";
import type { StackFrame } from "../../lib/trace";
import {
  balancedParens, postfixEval, parseParensInput, parsePostfixInput, parseStackText, STACK_PROGRAMS, stackToText,
} from "./stackAlgos";

/** Run a program over a fresh stack and hand back both the verdict and the recorded frames. */
function trace<T>(algo: (s: TracedStack) => T): { result: T; frames: StackFrame[] } {
  const s = new TracedStack("stack");
  const result = algo(s);
  return { result, frames: s.trace() };
}

const opsOf = (frames: StackFrame[]) => frames.flatMap((f) => (f.ops ?? []).map((o) => o.op));
const last = <T>(xs: T[]): T => xs[xs.length - 1];

describe("balancedParens (#3220)", () => {
  it.each([
    ["{[()()]}", true],
    ["()", true],
    ["", true],
    ["(]", false],
    ["(()", false],
    [")(", false],
  ])("judges %s as %s", (input, expected) => {
    expect(trace((s) => balancedParens(s, input)).result).toBe(expected);
  });

  it("ignores non-bracket characters but still traces the brackets", () => {
    const { result, frames } = trace((s) => balancedParens(s, "f(x[0])"));
    expect(result).toBe(true);
    expect(opsOf(frames)).toEqual(["push", "push", "pop", "pop"]);
  });

  it("PUSHES every opener and POPS on the matching closer — the frames are the algorithm's own calls", () => {
    const { frames } = trace((s) => balancedParens(s, "([])"));
    expect(opsOf(frames)).toEqual(["push", "push", "pop", "pop"]);
    // The first frame is the structure at rest, and the stack empties by the end.
    expect(frames[0].data).toEqual([]);
    expect(last(frames).data).toEqual([]);
  });

  it("stops at the failure, leaving the animation on it", () => {
    const { frames } = trace((s) => balancedParens(s, "(]))))"));
    expect(opsOf(frames)).toEqual(["push", "pop"]); // scan ends at the mismatch, not at the string's end
  });
});

describe("postfixEval (#3220)", () => {
  it.each([
    ["3 4 +", 7],
    ["3 4 + 2 *", 14],
    ["5 1 -", 4],
    ["8 2 /", 4],
    ["2 3 4 * +", 14],
  ])("evaluates %s to %d", (input, expected) => {
    expect(trace((s) => postfixEval(s, input)).result).toBe(expected);
  });

  it("pops the deeper operand as the LEFT-hand side — so - and / come out the right way round", () => {
    expect(trace((s) => postfixEval(s, "10 3 -")).result).toBe(7);   // not -7
    expect(trace((s) => postfixEval(s, "10 2 /")).result).toBe(5);   // not 0.2
  });

  it("shows the stack SHRINK under an operator", () => {
    const { frames } = trace((s) => postfixEval(s, "3 4 +"));
    const depths = frames.map((f) => f.data.length);
    expect(Math.max(...depths)).toBe(2); // both operands on
    expect(last(depths)).toBe(0);        // the final pop takes the answer off
  });

  it("yields 0 on division by zero rather than a non-renderable Infinity", () => {
    expect(trace((s) => postfixEval(s, "1 0 /")).result).toBe(0);
  });
});

describe("stack input parsers (#3220)", () => {
  it("accepts the shipped defaults", () => {
    for (const program of Object.values(STACK_PROGRAMS)) {
      expect(program.parse(program.defaultInput)).toBe(program.defaultInput);
    }
  });

  it.each([
    ["", /Enter a bracket/],
    ["   ", /Enter a bracket/],
    ["abc", /no brackets/],
    ["(".repeat(41), /40 characters/],
  ])("rejects %s with a helpful message", (text, msg) => {
    expect(() => parseParensInput(text)).toThrow(msg);
  });

  it.each([
    ["", /Enter a postfix/],
    ["3 4 &", /not a number/],
    ["3 +", /no two operands/],
    ["3 4", /exactly one value/],
  ])("rejects postfix %s with a helpful message", (text, msg) => {
    expect(() => parsePostfixInput(text)).toThrow(msg);
  });

  it("round-trips a seed through its text form", () => {
    for (const program of Object.values(STACK_PROGRAMS)) {
      expect(program.parse(stackToText(program.defaultInput))).toBe(program.defaultInput);
    }
  });
});

describe("runStackAlgorithm (#3220)", () => {
  it("replays a fresh, identical trace each call", () => {
    const factory = runStackAlgorithm((s) => balancedParens(s, "{[()]}"), "stack");
    expect([...factory()]).toEqual([...factory()]);
  });

  it("every shipped program produces a non-trivial stack trace", () => {
    for (const [key, program] of Object.entries(STACK_PROGRAMS)) {
      const factory = runStackAlgorithm((s) => program.run(s, program.defaultInput), program.mode);
      // `Frame` is the whole union (incl. the multi-panel scene frame) — a stack program only ever emits
      // StackFrames, which is exactly what the next assertion proves.
      const frames = [...factory()] as StackFrame[];
      expect(frames.length, key).toBeGreaterThan(2);
      expect(frames.every((f) => f.structure === "stack"), key).toBe(true);
    }
  });

  // #4162 — the seam a STORED stack program uses.
  it("the generic stored seam checks only that there is something to trace", () => {
    // By necessity, not by omission: the two shipped programs read different languages (brackets vs RPN),
    // so a shared parser could validate no more than the intersection — and a stored program's own
    // validation lives inside its `run`, the only place that knows which language it reads.
    expect(parseStackText("  ([{}])  ")).toBe("([{}])");
    expect(parseStackText("3 4 + 2 *")).toBe("3 4 + 2 *");
    expect(() => parseStackText("   ")).toThrow(/Enter an expression/);
    // Round-trips with the serializer, so a stored program's default input survives the field.
    expect(parseStackText(stackToText("([)"))).toBe("([)");
  });
});
