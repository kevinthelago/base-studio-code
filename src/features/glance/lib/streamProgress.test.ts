import { describe, it, expect } from "vitest";
import { streamProgress, progressFraction, withStreamProgress } from "./streamProgress";
import { TERMINAL_GOOD } from "@/shared/lib/fleet/workerEnd";
import type { OwnedIssue } from "@/shared/lib/fleet/workerEnd";

const i = (ref: string, status: string, stream?: string): OwnedIssue => ({ ref, status, stream });

describe("streamProgress (#4050)", () => {
  it("counts done/total per stream from ONE project read", () => {
    // The whole point of partitioning here: `OwnedIssue` carries its stream, so a project's issues are
    // read once and split in memory rather than queried per node.
    const p = streamProgress([
      i("#1", "complete", "auth"), i("#2", "open", "auth"), i("#3", "verified", "auth"),
      i("#4", "in_progress", "api"),
    ]);
    expect(p.get("auth")).toEqual({ done: 2, total: 3 });
    expect(p.get("api")).toEqual({ done: 0, total: 1 });
  });

  it("counts done the SAME way the finished-verdict does", () => {
    // Reusing TERMINAL_GOOD rather than restating it: a second definition would eventually disagree
    // with the card that says "finished", and the two would drift silently.
    for (const status of TERMINAL_GOOD) {
      expect(streamProgress([i("#1", status, "s")]).get("s")).toEqual({ done: 1, total: 1 });
    }
    for (const status of ["open", "in_progress", "blocked", "failed"]) {
      expect(streamProgress([i("#1", status, "s")]).get("s")).toEqual({ done: 0, total: 1 });
    }
  });

  it("skips issues that belong to no stream", () => {
    // Unowned work belongs to no worker; counting it would inflate every denominator invisibly.
    const p = streamProgress([i("#1", "open"), i("#2", "open", ""), i("#3", "open", "auth")]);
    expect([...p.keys()]).toEqual(["auth"]);
    expect(p.get("auth")!.total).toBe(1);
  });

  it("is empty for an empty project rather than throwing", () => {
    expect(streamProgress([]).size).toBe(0);
  });
});

describe("progressFraction (#4050)", () => {
  it("is the completed fraction", () => {
    expect(progressFraction({ done: 1, total: 4 })).toBe(0.25);
    expect(progressFraction({ done: 4, total: 4 })).toBe(1);
  });

  it("is 0 for no work — and the caller renders NO bar, which is a different statement", () => {
    expect(progressFraction({ done: 0, total: 0 })).toBe(0);
    expect(progressFraction(undefined)).toBe(0);
  });

  it("clamps, so a bad count can never overflow the bar", () => {
    expect(progressFraction({ done: 9, total: 4 })).toBe(1);
    expect(progressFraction({ done: -3, total: 4 })).toBe(0);
  });
});

describe("withStreamProgress (#4050)", () => {
  it("attaches by node id, which IS the stream id", () => {
    const nodes = [{ id: "auth" }, { id: "api" }];
    const out = withStreamProgress(nodes, new Map([["auth", { done: 1, total: 2 }]]));
    expect(out[0]).toMatchObject({ id: "auth", progress: { done: 1, total: 2 } });
    expect(out[1]).not.toHaveProperty("progress");
  });

  it("leaves nodes alone when nothing has been read yet", () => {
    // A project with no plan store, or a read that has not landed, must not blank an existing bar or
    // churn the memo that renders the graph.
    const nodes = [{ id: "auth" }];
    expect(withStreamProgress(nodes, new Map())).toEqual(nodes);
  });
});
