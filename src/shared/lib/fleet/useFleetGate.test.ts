import { describe, it, expect } from "vitest";
import { gatedProjects, newlyLaunchable } from "./useFleetGate";
import type { GateStream } from "./streamGate";

describe("gatedProjects", () => {
  it("derives the distinct project keys from the pane roster", () => {
    const roster = { "a:one": {}, "a:two": {}, "b:one": {} };
    expect(gatedProjects(roster).sort()).toEqual(["a", "b"]);
  });

  it("handles the director and triage pane shapes", () => {
    expect(gatedProjects({ "proj:director": {}, "proj:web:triage": {} })).toEqual(["proj"]);
  });

  it("an empty roster gates nothing — a project that never launched has nothing to release", () => {
    expect(gatedProjects({})).toEqual([]);
  });
});

describe("newlyLaunchable", () => {
  const ready: GateStream[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("returns the ready streams that have no live pane", () => {
    expect(newlyLaunchable(ready, "p", new Set(["p:a"]), {})).toEqual(["b", "c"]);
  });

  it("is a no-op once every ready stream is running — the idempotence the pump relies on", () => {
    // Without this the pump would re-launch the whole fleet on every coord-log line.
    expect(newlyLaunchable(ready, "p", new Set(["p:a", "p:b", "p:c"]), {})).toEqual([]);
  });

  it("never launches a quarantined stream", () => {
    // Quarantine is surfaced, never relaunched (#3916). The gate must not smuggle one back in.
    expect(newlyLaunchable(ready, "p", new Set(), { "p:b": { summary: "denied" } })).toEqual(["a", "c"]);
  });

  it("scopes pane ids by project — another project's live pane does not suppress this one", () => {
    expect(newlyLaunchable(ready, "p", new Set(["other:a"]), {})).toEqual(["a", "b", "c"]);
  });

  it("nothing ready ⇒ nothing launchable", () => {
    expect(newlyLaunchable([], "p", new Set(), {})).toEqual([]);
  });
});
