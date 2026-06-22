import { describe, it, expect } from "vitest";
import { renderTriageDelta, buildTriagePrompt } from "./constants";

describe("renderTriageDelta (#1004)", () => {
  it("returns '' for a first triage (no last-run marker) — the full pass", () => {
    expect(renderTriageDelta([], null)).toBe("");
    expect(renderTriageDelta([{ ref: "F1", title: "x", status: "complete" }], null)).toBe("");
  });

  it("a known last run with NO changes → a cheap RESUME, not a re-ingest", () => {
    const s = renderTriageDelta([], 1000);
    expect(s).toContain("RESUME");
    expect(s).toContain("nothing has changed");
    expect(s).toContain("do NOT re-ingest");
  });

  it("groups changed issues by transition (landed / blocked-failed) and leads with them", () => {
    const s = renderTriageDelta([
      { ref: "F1", title: "a", status: "complete" },
      { ref: "F2", title: "b", status: "verified" },
      { ref: "F3", title: "c", status: "blocked" },
      { ref: "F4", title: "d", status: "open" },
    ], 1000);
    expect(s).toContain("4 issue(s) changed");
    expect(s).toContain("landed F1, F2");
    expect(s).toContain("blocked/failed F3");
    expect(s).toContain("do NOT re-ingest");
  });
});

describe("buildTriagePrompt delta lead (#1004)", () => {
  it("prepends the delta when provided", () => {
    const p = buildTriagePrompt(true, "RESUME: since your last triage, 2 issue(s) changed.");
    expect(p.startsWith("RESUME: since your last triage")).toBe(true);
    expect(p).toContain("You are triaging"); // the full triage instructions still follow
  });

  it("no delta → the unchanged full prompt (back-compat)", () => {
    expect(buildTriagePrompt(true).startsWith("You are triaging")).toBe(true);
  });
});
