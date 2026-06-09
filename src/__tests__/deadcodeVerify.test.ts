import { describe, it, expect, vi } from "vitest";
import { verifyFindings, findingsToGrade, type VerifiedFinding } from "../lib/deadcodeVerify";
import { type DeadCodeFinding } from "../lib/deadcode";

const f = (over: Partial<DeadCodeFinding>): DeadCodeFinding => ({
  kind: "unused-dep", path: "package.json", symbol: "lodash", detail: "declared but never imported",
  tool: "depcheck", confidence: "medium", ...over,
});

describe("verifyFindings (#626 slice b)", () => {
  it("maps model verdicts onto findings in order", async () => {
    const findings = [f({ symbol: "lodash" }), f({ symbol: "moment" }), f({ kind: "unused-export", symbol: "Foo", path: "src/a.ts" })];
    const complete = vi.fn(async (_p: { system: string; user: string }) => JSON.stringify([
      { verdict: "confirmed", reason: "no references" },
      { verdict: "false-positive", reason: "used in webpack config" },
      { verdict: "uncertain", reason: "maybe re-exported" },
    ]));
    const out = await verifyFindings(findings, complete);
    expect(out.map((v) => v.verdict)).toEqual(["confirmed", "false-positive", "uncertain"]);
    expect(out[1].reason).toMatch(/webpack/);
    // the prompt listed the candidates
    expect(complete.mock.calls[0]![0].user).toMatch(/lodash/);
  });

  it("defaults to 'uncertain' on bad/short output (never auto-confirms)", async () => {
    const out = await verifyFindings([f({}), f({ symbol: "x" })], async () => "the model rambled, no JSON");
    expect(out.every((v) => v.verdict === "uncertain")).toBe(true);
  });

  it("no findings ⇒ [] without calling the model", async () => {
    const complete = vi.fn(async () => "[]");
    expect(await verifyFindings([], complete)).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });

  it("normalizes an unknown verdict string to uncertain", async () => {
    const out = await verifyFindings([f({})], async () => JSON.stringify([{ verdict: "definitely", reason: "" }]));
    expect(out[0].verdict).toBe("uncertain");
  });
});

describe("findingsToGrade (#626 slice b)", () => {
  const v = (verdict: VerifiedFinding["verdict"], over: Partial<DeadCodeFinding> = {}): VerifiedFinding => ({ ...f(over), verdict, reason: "" });

  it("clean (no confirmed) ⇒ score 100 / letter A", () => {
    const g = findingsToGrade([v("false-positive"), v("uncertain")], "cleanup");
    expect(g.graderId).toBe("cleanup");
    expect(g.score).toBe(100);
    expect(g.letter).toBe("A");
    // false-positives are not surfaced as findings; uncertain is (for review)
    expect(g.findings).toHaveLength(1);
    expect(g.findings[0].severity).toBe("info");
  });

  it("confirmed dead code lowers the score + surfaces removable findings", () => {
    const g = findingsToGrade([v("confirmed", { symbol: "lodash" }), v("confirmed", { kind: "unused-export", symbol: "Foo", path: "src/a.ts" })], "cleanup");
    expect(g.score).toBeLessThan(100);
    const removable = g.findings.filter((x) => x.fix === "safe to remove");
    expect(removable).toHaveLength(2);
    expect(g.dimensions.map((d) => d.label)).toContain("Unused dependencies");
  });
});
