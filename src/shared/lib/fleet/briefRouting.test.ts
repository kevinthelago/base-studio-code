import { describe, it, expect } from "vitest";
import { briefRouteKey, resolveBriefTarget, type BriefRouteContext } from "./briefRouting";

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

// DELETED WITH THEIR SUBJECT (#coord-prefix-names-the-sender): every suite below this point drove
// `briefInjections` and the three prompt builders, which are gone — nothing injected them.
//
// ONE OF THEM WAS LOAD-BEARING and its loss is the real cost of deleting rather than emptying: the
// "an architect brief is constrained to directors" suite was the only EXECUTABLE statement of the
// #funnel-generalize-brief-channel tier rule (an architect reaches directors and nothing else;
// intersect, never replace; refuse loudly rather than re-route). The rule is preserved as prose at
// the foot of briefRouting.ts. If brief delivery is rebuilt, restore these tests from git history
// (they were exact and hard-won) rather than re-deriving the rule from the prose.
