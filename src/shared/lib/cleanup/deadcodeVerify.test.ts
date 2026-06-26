import { describe, it, expect, vi } from "vitest";
import { verifyFindings } from "./deadcodeVerify";
import { type DeadCodeFinding } from "./deadcode";

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
