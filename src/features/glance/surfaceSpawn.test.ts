// The pane grammar + charter for the two personas on the crate drill
// (`a-noun-and-its-verbs-launch-their-personas`).
import { describe, it, expect } from "vitest";
import {
  nounPaneId, verbPaneId, surfacePaneIdForNode, surfaceAssignment, surfaceCharter,
  SURFACE_PANE_PREFIX,
} from "@/features/glance/lib/surfaceSpawn";
import type { CrateDrillDoc } from "@/features/glance/lib/surfaceNodes";

const doc: CrateDrillDoc = {
  crate: "logs", path: "crates/logs", surface: true, nouns: [],
  dependsOn: [], dependents: [], dependentCount: 0,
};

describe("a surface node's pane is DERIVED from the node", () => {
  it("resolves a noun and a verb, and nothing else", () => {
    expect(surfacePaneIdForNode("noun:logs")).toBe(nounPaneId("logs"));
    expect(surfacePaneIdForNode("verb:logs:sessions")).toBe(verbPaneId("logs", "sessions"));
    // not a surface node — must not mint a pane nothing can match back
    expect(surfacePaneIdForNode("studio-code:director")).toBeNull();
    expect(surfacePaneIdForNode("surface:logs")).toBeNull();
  });

  it("keys a verb pane on BOTH noun and verb", () => {
    // `bsc logs summary` and `bsc perf summary` are different commands; sharing one session would put
    // two maintainers in one terminal and lose whichever arrived second.
    expect(verbPaneId("logs", "summary")).not.toBe(verbPaneId("perf", "summary"));
  });

  it("refuses a malformed verb id rather than guessing", () => {
    // A pane minted from a half-parsed id can never be matched back to a node, so the session becomes
    // unopenable and unkillable — the failure the derived-id rule exists to prevent.
    expect(surfacePaneIdForNode("verb:")).toBeNull();
    expect(surfacePaneIdForNode("verb:logs")).toBeNull();
    expect(surfacePaneIdForNode("verb:logs:")).toBeNull();
    expect(surfacePaneIdForNode("verb::sessions")).toBeNull();
  });

  it("puts every surface pane under one prefix", () => {
    for (const id of [nounPaneId("logs"), verbPaneId("logs", "tail")]) {
      expect(id.startsWith(SURFACE_PANE_PREFIX)).toBe(true);
    }
  });
});

describe("the assignment says which persona and what it is pointed at", () => {
  it("a noun is an OPERATOR, a verb is a MAINTAINER", () => {
    expect(surfaceAssignment("noun:logs", doc)).toEqual({ kind: "operator", crate: "logs", noun: "logs" });
    expect(surfaceAssignment("verb:logs:tail", doc)).toEqual({
      kind: "maintainer", crate: "logs", noun: "logs", verb: "tail",
    });
  });

  it("is null with no document — the crate is not knowable from the node alone", () => {
    expect(surfaceAssignment("noun:logs", null)).toBeNull();
  });
});

describe("the charter carries the persona's own words, then the assignment", () => {
  it("leads with the persona prompt rather than restating it", () => {
    // ONE copy of what an operator is. A charter that re-described the persona would drift from it, and
    // drift between two descriptions of the same actor is the failure this whole catalog exists to end.
    const c = surfaceCharter({ kind: "operator", crate: "logs", noun: "logs" }, "PERSONA-PROMPT-BODY");
    expect(c.startsWith("PERSONA-PROMPT-BODY")).toBe(true);
  });

  it("gives the operator the EXACT --surface string its requests must carry", () => {
    // The maintainer's queue is `bsc request list --surface <noun>`. If the operator files under
    // anything else the report is filed, correct, and invisible to the only actor who can act on it.
    const c = surfaceCharter({ kind: "operator", crate: "logs", noun: "metrics" }, "P");
    expect(c).toContain('--surface "metrics"');
    expect(c).toContain("bsc request new");
  });

  it("points the maintainer at that same queue, and at the catalog it must keep true", () => {
    const c = surfaceCharter({ kind: "maintainer", crate: "logs", noun: "metrics", verb: "cost" }, "P");
    expect(c).toContain('bsc request list --surface "metrics"');
    expect(c).toContain("bsc surface verbs metrics");
    expect(c).toContain("bsc metrics cost");
  });
});
