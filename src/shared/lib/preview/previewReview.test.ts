import { describe, it, expect } from "vitest";
import {
  mergeFindings,
  setFindingStatus,
  pendingFindings,
  confirmedFindings,
  parseFindings,
  reviewDispatchPrompt,
  findingKey,
  reviewSystemPrompt,
  type ReviewFinding,
} from "./previewReview";

const f = (over: Partial<ReviewFinding>): ReviewFinding => ({
  id: "f1", shotId: "s1", severity: "issue", title: "Buttons overlap", detail: "Fix the flex gap.", status: "pending", ...over,
});

describe("previewReview — the confirm-gated reviewer core (#2623 slice 5)", () => {
  describe("mergeFindings (DEDUP)", () => {
    it("appends new findings as pending", () => {
      const merged = mergeFindings([], [f({ id: "x" })]);
      expect(merged.map((m) => ({ id: m.id, status: m.status }))).toEqual([{ id: "x", status: "pending" }]);
    });

    it("drops a re-reviewed duplicate (same shot + title) and keeps the existing status", () => {
      const existing = [f({ id: "a", status: "confirmed" })];
      // re-review surfaces the same problem (case/space-insensitive) — must NOT duplicate or reset status
      const merged = mergeFindings(existing, [f({ id: "b", title: "  buttons   OVERLAP " })]);
      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({ id: "a", status: "confirmed" });
    });

    it("keeps distinct findings on the same shot", () => {
      const merged = mergeFindings([f({ id: "a", title: "Overlap" })], [f({ id: "b", title: "Low contrast" })]);
      expect(merged.map((m) => m.id)).toEqual(["a", "b"]);
    });

    it("keys the same title on different shots separately", () => {
      expect(findingKey({ shotId: "s1", title: "X" })).not.toEqual(findingKey({ shotId: "s2", title: "X" }));
    });
  });

  describe("GATE — only confirmed findings are dispatchable", () => {
    const findings = [
      f({ id: "a", severity: "polish", status: "confirmed" }),
      f({ id: "b", severity: "blocker", status: "confirmed" }),
      f({ id: "c", status: "pending" }),
      f({ id: "d", status: "dismissed" }),
    ];

    it("pendingFindings lists only pending (worst first)", () => {
      expect(pendingFindings(findings).map((x) => x.id)).toEqual(["c"]);
    });

    it("confirmedFindings excludes pending + dismissed and sorts worst-first", () => {
      expect(confirmedFindings(findings).map((x) => x.id)).toEqual(["b", "a"]);
    });

    it("setFindingStatus transitions one finding immutably", () => {
      const next = setFindingStatus(findings, "c", "confirmed");
      expect(next.find((x) => x.id === "c")?.status).toBe("confirmed");
      expect(findings.find((x) => x.id === "c")?.status).toBe("pending"); // original untouched
    });
  });

  describe("parseFindings (PARSE — tolerant)", () => {
    const idFor = (i: number) => `f${i}`;

    it("parses a plain JSON array and mints ids + shotId", () => {
      const raw = '[{"severity":"blocker","title":"Blank screen","detail":"Renders nothing."}]';
      expect(parseFindings(raw, "s7", idFor)).toEqual([
        { id: "f0", shotId: "s7", severity: "blocker", title: "Blank screen", detail: "Renders nothing.", status: "pending" },
      ]);
    });

    it("strips a code fence + surrounding prose", () => {
      const raw = "Here you go:\n```json\n[{\"title\":\"Nit\"}]\n```\nHope that helps!";
      const out = parseFindings(raw, "s1", idFor);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ title: "Nit", severity: "issue", shotId: "s1" }); // severity defaults
    });

    it("returns [] for junk / non-array / empty and never throws", () => {
      expect(parseFindings("no json here", "s1", idFor)).toEqual([]);
      expect(parseFindings('{"not":"an array"}', "s1", idFor)).toEqual([]);
      expect(parseFindings("[]", "s1", idFor)).toEqual([]);
    });

    it("skips entries with no usable title", () => {
      const raw = '[{"severity":"issue"},{"title":"   "},{"title":"Real one"}]';
      expect(parseFindings(raw, "s1", idFor).map((x) => x.title)).toEqual(["Real one"]);
    });
  });

  describe("reviewDispatchPrompt", () => {
    it("routes confirmed findings via the bsc-issue → bsc-assign convention with the screen label", () => {
      const confirmed = [f({ id: "a", title: "Overlap", detail: "Fix gap.", shotId: "s1" })];
      const prompt = reviewDispatchPrompt(confirmed, (id) => (id === "s1" ? "Dashboard" : ""));
      expect(prompt).toContain("preview-review");
      expect(prompt).toContain("Overlap — Fix gap. (screen: Dashboard)");
      expect(prompt).toContain("bsc-issue");
      expect(prompt).toContain("bsc-assign");
    });
  });

  it("reviewSystemPrompt demands a JSON-only answer", () => {
    expect(reviewSystemPrompt()).toContain("JSON array");
  });
});
