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

describe("newlyLaunchable (#3971)", () => {
  const ready: GateStream[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("launches every ready stream — a pane cell is NOT evidence an agent is running", () => {
    // The regression this fixes: the pump subtracted "live" panes using tab membership, so at boot
    // all 29 persisted panes counted as live — including the 25 that had come up as BARE SHELLS
    // (`init=<none>`). It released 3 streams against a fleet with 13 dependency-free roots.
    expect(newlyLaunchable(ready, "p", {})).toEqual(["a", "b", "c"]);
  });

  it("never launches a quarantined stream", () => {
    // Quarantine is surfaced, never relaunched (#3916) — the one exclusion that survives.
    expect(newlyLaunchable(ready, "p", { "p:b": { summary: "denied" } })).toEqual(["a", "c"]);
  });

  it("scopes quarantine by project — another project's pane does not suppress this one", () => {
    expect(newlyLaunchable(ready, "p", { "other:a": { summary: "x" } })).toEqual(["a", "b", "c"]);
  });

  it("nothing ready ⇒ nothing launchable", () => {
    expect(newlyLaunchable([], "p", {})).toEqual([]);
  });

  it("relaunching an already-running stream is safe, so it is not filtered out", () => {
    // `resumeProjectFleet` is the actuator and `pty_create` reconnects to an existing session before
    // spawning (#3923), so including a live pane never re-sends `--continue`. Repeat-firing is the
    // caller's `lastFired` fingerprint's job — not a liveness proxy that is wrong at boot.
    const twice = [newlyLaunchable(ready, "p", {}), newlyLaunchable(ready, "p", {})];
    expect(twice[0]).toEqual(twice[1]);
  });
});
