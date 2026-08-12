import { describe, it, expect } from "vitest";
import {
  briefInjections, briefRouteKey, resolveBriefTarget,
  directorBriefPrompt, targetedBriefPrompt, undeliverableBriefPrompt,
  type BriefRouteContext,
} from "./briefRouting";
import type { ReceivedBrief } from "./coordination.types";

const brief = (over: Partial<ReceivedBrief> = {}): ReceivedBrief => ({
  id: "planner@1", from: "planner", target: "director", body: "scope grew: add CSV export", at: 1, ...over,
});

const ctx = (over: Partial<BriefRouteContext> = {}): BriefRouteContext => ({
  directorPanes: ["studio-code:director"],
  knownPanes: ["studio-code:director", "studio-code:security", "studio-code:fleet", "studio-code:issuer"],
  surfaced: new Set<string>(),
  ...over,
});

describe("resolveBriefTarget", () => {
  it("resolves an exact pane id to that pane alone", () => {
    expect(resolveBriefTarget("studio-code:security", ctx())).toEqual(["studio-code:security"]);
  });

  it("resolves a bare stream id by suffix — a sibling need not know the project key", () => {
    expect(resolveBriefTarget("security", ctx())).toEqual(["studio-code:security"]);
  });

  it("resolves the director + issuer broadcast audiences", () => {
    expect(resolveBriefTarget("director", ctx())).toEqual(["studio-code:director"]);
    expect(resolveBriefTarget("issuer", ctx())).toEqual(["studio-code:issuer"]);
  });

  it("prefers a real pane over the broadcast name — a stream called 'director' cannot hijack it", () => {
    const c = ctx({ knownPanes: ["proj:director", "other:director"], directorPanes: ["proj:director"] });
    // An exact id wins outright.
    expect(resolveBriefTarget("proj:director", c)).toEqual(["proj:director"]);
    // A bare `director` matches by suffix BEFORE falling through to the audience, so both real
    // director panes are reached rather than only the drive-registered one.
    expect(resolveBriefTarget("director", c)).toEqual(["proj:director", "other:director"]);
  });

  it("an unknown target resolves to nothing (the caller reports it)", () => {
    expect(resolveBriefTarget("no-such-stream", ctx())).toEqual([]);
  });

  it("an empty target keeps the old behaviour — the director panes", () => {
    expect(resolveBriefTarget("", ctx())).toEqual(["studio-code:director"]);
  });
});

describe("briefRouteKey", () => {
  it("includes the target, so two briefs sent in the same millisecond do not collide", () => {
    // The regression: the old key was `<from>@<at>`, so the second of these was suppressed as
    // already-surfaced and never delivered.
    const a = briefRouteKey({ from: "studio-code:director", at: 7, target: "security" });
    const b = briefRouteKey({ from: "studio-code:director", at: 7, target: "fleet" });
    expect(a).not.toBe(b);
  });
});

describe("briefInjections", () => {
  it("THE BUG: a director briefing a worker does not brief itself", () => {
    const b = brief({ from: "studio-code:director", target: "studio-code:security", id: "d@2", at: 2 });
    const due = briefInjections([b], ctx());
    expect(due.map((d) => d.paneId)).toEqual(["studio-code:security"]);
    expect(due.map((d) => d.paneId)).not.toContain("studio-code:director");
  });

  it("a worker's brief carries worker prose — no board, no bsc-assign", () => {
    const due = briefInjections([brief({ target: "security" })], ctx());
    expect(due[0].prompt).toMatch(/authoritative context for YOUR lane/);
    expect(due[0].prompt).not.toMatch(/bsc-assign/);
    expect(due[0].prompt).not.toMatch(/update the board/);
  });

  it("a director-targeted brief still gets the reconcile-and-route prose", () => {
    const due = briefInjections([brief({ target: "director" })], ctx());
    expect(due[0].paneId).toBe("studio-code:director");
    expect(due[0].prompt).toMatch(/bsc-assign/);
    expect(due[0].prompt).toMatch(/Reconcile the running plan/);
  });

  it("batches several briefs for one pane into a single injection carrying every key", () => {
    const due = briefInjections(
      [brief({ id: "a", at: 1, target: "security" }), brief({ id: "b", at: 2, target: "security" })],
      ctx(),
    );
    expect(due).toHaveLength(1);
    expect(due[0].keys).toHaveLength(2);
    expect(due[0].prompt).toMatch(/2 update\(s\)/);
  });

  it("reports an undeliverable target to the director instead of dropping it", () => {
    const due = briefInjections([brief({ target: "not-launched" })], ctx());
    expect(due.map((d) => d.paneId)).toEqual(["studio-code:director"]);
    expect(due[0].prompt).toMatch(/could NOT be delivered/);
    expect(due[0].prompt).toMatch(/not-launched/);
    expect(due[0].prompt).toMatch(/bsc fleet wake/);
  });

  it("injects each brief exactly once per pane", () => {
    const b = brief({ target: "security" });
    const first = briefInjections([b], ctx());
    const surfaced = new Set(first.flatMap((d) => d.keys));
    expect(briefInjections([b], ctx({ surfaced }))).toEqual([]);
  });

  it("does not re-report an undeliverable brief every tick", () => {
    const b = brief({ target: "gone" });
    const first = briefInjections([b], ctx());
    const surfaced = new Set(first.flatMap((d) => d.keys));
    expect(briefInjections([b], ctx({ surfaced }))).toEqual([]);
  });

  it("delivers to a pane that only became reachable later (restart-safe, must-not-drop)", () => {
    const b = brief({ target: "late-stream" });
    // Not reachable yet ⇒ reported to the director, not delivered.
    expect(briefInjections([b], ctx())[0].paneId).toBe("studio-code:director");
    // Once its pane exists, the SAME brief delivers — its delivery key was never surfaced.
    const later = ctx({ knownPanes: [...ctx().knownPanes, "studio-code:late-stream"] });
    expect(briefInjections([b], later).map((d) => d.paneId)).toEqual(["studio-code:late-stream"]);
  });

  it("a ref is named in the prose so the recipient can act on it", () => {
    const due = briefInjections(
      [brief({ target: "security", ref: { kind: "issue", number: 412 } })],
      ctx(),
    );
    expect(due[0].prompt).toContain("#412");
  });
});

describe("the prompts", () => {
  it("each names every brief it carries", () => {
    const bs = [brief({ body: "one" }), brief({ body: "two", id: "x", at: 2 })];
    for (const p of [directorBriefPrompt(bs), targetedBriefPrompt(bs, "planner"), undeliverableBriefPrompt(bs)]) {
      expect(p).toContain("one");
      expect(p).toContain("two");
    }
  });

  it("the targeted prompt tells a worker to refuse out-of-lane work rather than take it", () => {
    const p = targetedBriefPrompt([brief()], "studio-code:director");
    expect(p).toMatch(/outside your owned globs/);
    expect(p).toMatch(/bsc-ask/);
  });
});
