// Unit tests for the per-node Glance OFF toggle store action (#3239). Deactivates a node on the
// project-network graph so it renders greyed; defaults ON (absent) and persists per node id, sparse
// like autoTriage (turning back on drops the entry).
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";

describe("setGlanceNodeOff (#3239)", () => {
  beforeEach(() => {
    useAppStore.setState({ glanceOff: {} });
  });

  it("defaults to ON (absent ⇒ the node shows its derived status)", () => {
    expect(useAppStore.getState().glanceOff["proj-a"]).toBeUndefined();
  });

  it("turns a node OFF (deactivated)", () => {
    useAppStore.getState().setGlanceNodeOff("proj-a", true);
    expect(useAppStore.getState().glanceOff["proj-a"]).toBe(true);
  });

  it("turning back ON drops the entry (keeps the map sparse)", () => {
    const { setGlanceNodeOff } = useAppStore.getState();
    setGlanceNodeOff("proj-a", true);
    setGlanceNodeOff("proj-a", false);
    expect(useAppStore.getState().glanceOff["proj-a"]).toBeUndefined();
  });

  it("is per-node — flipping one leaves the others untouched", () => {
    const { setGlanceNodeOff } = useAppStore.getState();
    setGlanceNodeOff("proj-a", true);
    setGlanceNodeOff("proj-b", true);
    setGlanceNodeOff("proj-a", false);
    expect(useAppStore.getState().glanceOff["proj-a"]).toBeUndefined();
    expect(useAppStore.getState().glanceOff["proj-b"]).toBe(true);
  });
});
