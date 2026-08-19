import { describe, it, expect } from "vitest";
import { briefRouteKey, resolveBriefTarget, type BriefRouteContext } from "@/shared/lib/fleet/briefRouting";

const ctx = (over: Partial<BriefRouteContext> = {}): BriefRouteContext => ({
  directorPanes: ["studio-code:director"],
  knownPanes: ["studio-code:director", "studio-code:security", "studio-code:fleet", "studio-code:issuer"],
  surfaced: new Set<string>(),
  ...over,
});

/** The sender for the single-project fixtures above — every pane in `ctx()` is `studio-code:…`. */
const ME = "studio-code:planner";

describe("resolveBriefTarget", () => {
  it("resolves an exact pane id to that pane alone", () => {
    expect(resolveBriefTarget("studio-code:security", ctx(), ME)).toEqual(["studio-code:security"]);
  });

  it("resolves a bare stream id by suffix — a sibling need not know the project key", () => {
    expect(resolveBriefTarget("security", ctx(), ME)).toEqual(["studio-code:security"]);
  });

  it("resolves the director + issuer broadcast audiences", () => {
    expect(resolveBriefTarget("director", ctx(), ME)).toEqual(["studio-code:director"]);
    expect(resolveBriefTarget("issuer", ctx(), ME)).toEqual(["studio-code:issuer"]);
  });

  it("prefers a real pane over the broadcast name — a stream called 'director' cannot hijack it", () => {
    const c = ctx({ knownPanes: ["proj:director", "other:director"], directorPanes: ["proj:director"] });
    // An exact id wins outright, and stays cross-project on purpose: a targeted brief stays targeted.
    expect(resolveBriefTarget("proj:director", c, "other:planner")).toEqual(["proj:director"]);
    // A bare `director` still matches by suffix before the audience — but only within the sender's own
    // project. This assertion used to expect BOTH directors; that was the bug (#59), not the contract.
    expect(resolveBriefTarget("director", c, "proj:planner")).toEqual(["proj:director"]);
  });

  it("an unknown target resolves to nothing (the caller reports it)", () => {
    expect(resolveBriefTarget("no-such-stream", ctx(), ME)).toEqual([]);
  });

  it("an empty target keeps the old behaviour — the director panes", () => {
    expect(resolveBriefTarget("", ctx(), ME)).toEqual(["studio-code:director"]);
  });
});

// #59 — a planner's mid-build update reached a director in an UNRELATED project and told it to open
// issues and assign work on a board it does not own. It declined; the next one might not. Everything
// except an exact pane id is now scoped to the sender's project.
describe("resolveBriefTarget — the sender's project bounds every broadcast (#59)", () => {
  const twoProjects = ctx({
    directorPanes: ["studio-code:director", "network-monitor:director"],
    knownPanes: [
      "studio-code:director", "studio-code:security", "studio-code:issuer",
      "network-monitor:director", "network-monitor:security", "network-monitor:issuer",
    ],
  });

  it("REPRODUCER: `director` reaches only the sender's own director", () => {
    expect(resolveBriefTarget("director", twoProjects, "studio-code:planner")).toEqual(["studio-code:director"]);
    expect(resolveBriefTarget("director", twoProjects, "network-monitor:planner")).toEqual(["network-monitor:director"]);
  });

  it("an UNTARGETED brief does not broadcast across projects either", () => {
    expect(resolveBriefTarget("", twoProjects, "network-monitor:api")).toEqual(["network-monitor:director"]);
  });

  it("a bare stream id resolves inside the sender's project, not every project's namesake", () => {
    expect(resolveBriefTarget("security", twoProjects, "studio-code:planner")).toEqual(["studio-code:security"]);
  });

  it("the issuer audience is scoped the same way", () => {
    expect(resolveBriefTarget("issuer", twoProjects, "network-monitor:api")).toEqual(["network-monitor:issuer"]);
  });

  it("an EXACT pane id still crosses projects — a targeted brief stays targeted", () => {
    // The architect's case: `bsc-brief <project>:director` names that director and must reach it.
    expect(resolveBriefTarget("network-monitor:director", twoProjects, "studio-code:architect"))
      .toEqual(["network-monitor:director"]);
  });

  it("a sender with no project prefix reaches NOBODY rather than everybody", () => {
    // Broadcasting on an unparseable sender is the failure this exists to stop; an empty audience is
    // reported undeliverable by the caller, which is loud and fixable.
    expect(resolveBriefTarget("director", twoProjects, "orphan")).toEqual([]);
    expect(resolveBriefTarget("", twoProjects, "")).toEqual([]);
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
