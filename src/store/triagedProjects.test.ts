import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";

// The TRIAGED marker (#2541) — the durable drafted→triaged transition that gates the Glance network.
// markProjectTriaged is idempotent; both triageStartProject and fleetStartProject stamp it on launch.
describe("triagedProjects marker (#2541)", () => {
  beforeEach(() => useAppStore.setState({ triagedProjects: {}, tabs: [], localDraftProjects: {} }));

  it("markProjectTriaged stamps a key and is idempotent (keeps the first timestamp)", () => {
    useAppStore.getState().markProjectTriaged("proj-a");
    const first = useAppStore.getState().triagedProjects["proj-a"];
    expect(first).toBeGreaterThan(0);
    useAppStore.getState().markProjectTriaged("proj-a");
    expect(useAppStore.getState().triagedProjects["proj-a"]).toBe(first); // unchanged on re-mark
  });

  it("ignores an empty key", () => {
    useAppStore.getState().markProjectTriaged("");
    expect(useAppStore.getState().triagedProjects).toEqual({});
  });

  it("triageStartProject marks the project triaged", () => {
    useAppStore.getState().triageStartProject("Proj", ["own/web"], "proj-key");
    expect(useAppStore.getState().triagedProjects["proj-key"]).toBeGreaterThan(0);
  });

  it("fleetStartProject marks the project triaged", () => {
    const fleet: FleetPlan = {
      recommended: 1, reasoning: "",
      streams: [{ id: "s", name: "S", repo: "o/r", owns: [], issues: [], dependsOn: [] }],
      director: { enabled: false },
    } as never;
    useAppStore.getState().fleetStartProject("Proj", fleet, "fleet-key");
    expect(useAppStore.getState().triagedProjects["fleet-key"]).toBeGreaterThan(0);
  });
});
