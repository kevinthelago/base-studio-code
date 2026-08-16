/**
 * @vitest-environment jsdom
 *
 * This file lives under `lib/`, which vitest's `node` project covers, but it genuinely needs a DOM.
 * A per-file docblock beats the project's environment, so the requirement is stated where a reader
 * meets it. See the `projects` split in vitest.config.ts for why the default is `node` here.
 */
import { describe, it, expect, vi } from "vitest";
import { gatedProjects, newlyLaunchable } from "@/shared/lib/fleet/useFleetGate";
import type { GateStream } from "@/shared/lib/fleet/streamGate";

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

// #fleet-gate-stops-launching-on-its-own — the pump must never launch.
//
// It read the coord log ON MOUNT and called `resumeProjectFleet`, which relaunches a whole fleet with
// baked kickoff prompts — measured at boot as `claude --continue "You are the OPNsense adapter worker…"`.
// The guard is written against the ACTUATOR: if the injected launcher is ever called, a fleet started.
describe("useFleetGate performs no launch", () => {
  // TIMEOUT RAISED FROM THE 5s DEFAULT (#the-suite-fails-intermittently-under-load...). The four
  // dynamic imports below drag the store + testing-library + the hook through vitest's transform, so
  // this is IMPORT-bound; under several concurrent worktree agents it blew the 5s budget and failed
  // with "Test timed out", never an assertion.
  //
  // Worth fixing rather than tolerating BECAUSE OF WHAT THIS GUARDS: useFleetGate is the launch pump
  // that survived two removal attempts (a source grep cannot see its record-based mount point). A
  // guard that goes green-on-retry is a guard that can go red for the RIGHT reason and be waved
  // through as "just the flake".
  it("never calls its launcher — with the store ARMED exactly as it is at a real boot", async () => {
    // The state matters: an empty store makes the old pump bail at `gatedProjects` before it could
    // launch, so a naive version of this test passes against the unfixed code and proves nothing.
    // (It did. This is the armed version.) Here `demo` has a pane, a fleet with a dependsOn edge, and
    // landed evidence that releases it — the shape that fired at boot on the real machine.
    const { renderHook } = await import("@testing-library/react");
    const { useAppStore } = await import("@/store");
    const { invoke } = await import("@tauri-apps/api/core");
    const { useFleetGate } = await import("@/shared/lib/fleet/useFleetGate");

    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "fleet_landed_streams") return Promise.resolve(["core"]);  // core has landed…
      if (cmd === "logs_tail") return Promise.resolve([]);
      if (cmd === "bsc") return Promise.resolve(JSON.stringify([]));
      return Promise.resolve(undefined);
    });
    useAppStore.setState({
      fleetPaneStreams: { "demo:api": { id: "api" }, "demo:core": { id: "core" } },
      planFleet: { demo: { streams: [
        { id: "core", name: "core", repo: "me/app", owns: [], issues: [], dependsOn: [] },
        { id: "api", name: "api", repo: "me/app", owns: [], issues: [], dependsOn: ["core"] },
      ] } },
      quarantinedPanes: {},
    } as never);

    const launch = vi.fn(() => Promise.resolve());
    renderHook(() => useFleetGate(launch));
    await new Promise((r) => setTimeout(r, 50));

    expect(launch, "the app must not start a fleet on its own").not.toHaveBeenCalled();
  }, 15_000);

  it("keeps its pure core, so re-enabling is restoring a body rather than a rewrite", async () => {
    const m = await import("@/shared/lib/fleet/useFleetGate");
    expect(typeof m.gatedProjects).toBe("function");
    expect(typeof m.newlyLaunchable).toBe("function");
  });
});
