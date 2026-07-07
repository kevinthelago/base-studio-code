// Tunnel slice — the keyed extra-pane registry (#2497): independent sources (planner,
// designer, …) register their mirrored sessions without clobbering each other.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import type { PaneDescriptor } from "./lib/tunnel";

const planner: PaneDescriptor = {
  id: "planning_proj", cwd: "/hub/proj", name: "Planner — proj", status: "running", kind: "planner",
};
const designer: PaneDescriptor = {
  id: "design-studio:designer", cwd: "/design-studio", name: "Design Studio", status: "running", kind: "designer",
};

describe("registerTunnelPanes (#2497)", () => {
  beforeEach(() => {
    useAppStore.setState({ tunnelExtraPanes: {} });
  });

  it("registers panes under their source key", () => {
    useAppStore.getState().registerTunnelPanes("planner", [planner]);
    expect(useAppStore.getState().tunnelExtraPanes).toEqual({ planner: [planner] });
  });

  it("two sources coexist — one registering never clobbers the other", () => {
    useAppStore.getState().registerTunnelPanes("planner", [planner]);
    useAppStore.getState().registerTunnelPanes("designer", [designer]);
    expect(useAppStore.getState().tunnelExtraPanes).toEqual({
      planner: [planner],
      designer: [designer],
    });
  });

  it("re-registering a source replaces only that source's panes", () => {
    useAppStore.getState().registerTunnelPanes("planner", [planner]);
    useAppStore.getState().registerTunnelPanes("designer", [designer]);
    const renamed = { ...planner, name: "Planner — other" };
    useAppStore.getState().registerTunnelPanes("planner", [renamed]);
    expect(useAppStore.getState().tunnelExtraPanes.planner).toEqual([renamed]);
    expect(useAppStore.getState().tunnelExtraPanes.designer).toEqual([designer]);
  });

  it("registering [] unregisters the source (key removed, others untouched)", () => {
    useAppStore.getState().registerTunnelPanes("planner", [planner]);
    useAppStore.getState().registerTunnelPanes("designer", [designer]);
    useAppStore.getState().registerTunnelPanes("planner", []);
    expect(useAppStore.getState().tunnelExtraPanes).toEqual({ designer: [designer] });
  });
});
