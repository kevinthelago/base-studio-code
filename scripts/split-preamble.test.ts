// `splitPreamble` — where a record's own header ends and the module it mirrors begins.
//
// Both directions are load-bearing and each has already cost something:
//
//   strip too little  → the record's `AS GRAPH SOURCE` block counts as code, so every migrated record
//                       grades as drift and nothing is retirable.
//   strip too much    → the block is deleted on a refresh. That happened: four records SHRANK while the
//                       change only meant to add attributes.
//
// And the case this file was written for: a file that OPENS with `/**` had that line eaten, so six
// byte-identical records graded BODY-DIFFERS and were held back — `plannerCore/hash` among them, itself
// blocking three more modules.
import { describe, it, expect } from "vitest";
// A relative path on purpose: `scripts/` is outside the `@/` alias (which maps to `src/`).
import { splitPreamble } from "./lib/recordSource.mjs";

const FILE = [
  "/**",
  " * FNV-1a 32-bit hash — the canonical hash for the planner-sync protocol.",
  " */",
  "export function fnv1a32(s: string): number {",
  "  return s.length;",
  "}",
].join("\n");

const PREAMBLE = [
  "// hash, AS GRAPH SOURCE (#3654, epic #3604). Transcribed from the live feature file: the runtime",
  "// loader compiles this and mounts it, resolving every import to the app's real modules.",
].join("\n");

describe("splitPreamble", () => {
  it("finds NO preamble when the record is byte-identical to the file", () => {
    // The regression. `/**` is 3 characters, so the >8 filter skipped it and the split landed on line 2.
    const [pre, body] = splitPreamble(FILE, FILE);
    expect(pre).toBe("");
    expect(body).toBe(FILE);
  });

  it("still strips a real AS GRAPH SOURCE block off a file that opens with `/**`", () => {
    const [pre, body] = splitPreamble(`${PREAMBLE}\n${FILE}`, FILE);
    expect(pre).toBe(PREAMBLE);
    expect(body).toBe(FILE);
  });

  it("strips a real preamble when the file opens with code rather than a comment", () => {
    const plain = `export const x = 1;\nexport const y = 2;\n`;
    const [pre, body] = splitPreamble(`${PREAMBLE}\n${plain}`, plain);
    expect(pre).toBe(PREAMBLE);
    expect(body).toBe(plain);
  });

  it("falls back to the line heuristic when the file's first line was reworded", () => {
    // A transcribed record whose head does not match verbatim still finds the body at the first
    // substantial shared line — the original behaviour, unchanged.
    const record = `${PREAMBLE}\n/** reworded */\nexport function fnv1a32(s: string): number {\n  return s.length;\n}`;
    const [pre, body] = splitPreamble(record, FILE);
    expect(pre).toContain("AS GRAPH SOURCE");
    expect(body.startsWith("export function fnv1a32")).toBe(true);
  });

  it("does not eat code when nothing matches", () => {
    expect(splitPreamble("export const only = 1;", "export const different = 2;")).toEqual(["", "export const only = 1;"]);
  });

  it("is bounded to the head — a match deep in a long module cannot eat real code", () => {
    const long = Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const record = `${long}\n${FILE}`;
    const [pre] = splitPreamble(record, FILE);
    expect(pre).toBe(""); // the match is past line 60, so nothing is stripped
  });
});
