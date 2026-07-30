import { describe, it, expect } from "vitest";
import { openIssueKeys } from "./useProjectProgress";

// #4052 — the OPEN-ISSUES half of the `modifying` health state. The whole point of this state is that
// it means something, so what must NOT light up matters as much as what must.
describe("openIssueKeys — which projects have unfinished work (#4052)", () => {
  it("includes a project with work left and excludes a finished one", () => {
    const out = openIssueKeys([
      { key: "busy", done: 3, total: 7 },
      { key: "done", done: 7, total: 7 },
    ]);
    expect([...out]).toEqual(["busy"]);
  });

  it("does NOT count a planned-but-empty project — zero issues is not work in flight", () => {
    // Every local plan store currently reports 0/0 (planned, no issues authored). Treating that as
    // "open" would paint the entire board `modifying` and make the state meaningless.
    expect([...openIssueKeys([{ key: "empty", done: 0, total: 0 }])]).toEqual([]);
  });

  it("counts a planned project that has not started — 0 of 5 IS work in flight", () => {
    expect([...openIssueKeys([{ key: "fresh", done: 0, total: 5 }])]).toEqual(["fresh"]);
  });

  it("survives a malformed or empty read without inventing keys", () => {
    expect([...openIssueKeys([])]).toEqual([]);
    // The CLI is the only writer, but a shape change must degrade to "we know nothing" rather than
    // adding an `undefined` key that would match no project and quietly never fire.
    expect([...openIssueKeys([{ key: undefined as unknown as string, done: 0, total: 3 }])]).toEqual([]);
  });

  it("ignores a nonsense over-count rather than reporting it as open", () => {
    expect([...openIssueKeys([{ key: "weird", done: 9, total: 3 }])]).toEqual([]);
  });
});
