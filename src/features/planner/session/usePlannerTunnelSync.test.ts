// #1775: usePlannerTunnelSync was extracted from Planning.tsx. These tests pin the one invariant the
// whole hook is built around — every tunnel emit is gated on the relay being live AND a non-empty
// plan (canonicalPlan != null). The emit/listen wiring itself is a verbatim move; this guards that
// the gate survived the extraction (a regression here would silently leak frames or go dark).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppStore } from "@/store";
import { usePlannerTunnelSync, type PlannerTunnelSyncOpts } from "./usePlannerTunnelSync";

vi.mock("@/features/tunnel/lib/tunnelClient", () => ({
  tunnelSetPlanState: vi.fn().mockResolvedValue(undefined),
  tunnelEmitPlanState: vi.fn().mockResolvedValue(undefined),
  tunnelEmitPlanStatus: vi.fn().mockResolvedValue(undefined),
  tunnelEmitPlanEvent: vi.fn().mockResolvedValue(undefined),
}));
// The transcript poll is its own (separately-tested) hook — keep it inert here.
vi.mock("./usePlannerMessages", () => ({ usePlannerMessages: () => [] }));

import { tunnelSetPlanState, tunnelEmitPlanStatus } from "@/features/tunnel/lib/tunnelClient";

const base: PlannerTunnelSyncOpts = {
  effectiveProjectId: "proj",
  savedSections: { goal: "Build a thing" },
  confirmedSet: new Set<string>(),
  currentStage: "goal",
  planStatusLabel: "drafting",
  planningDir: "/tmp/proj",
  paneId: "planning_proj",
  projectTitle: "Proj",
  confirmPlanStage: () => {},
};

const render = (p: PlannerTunnelSyncOpts) =>
  renderHook((props: PlannerTunnelSyncOpts) => usePlannerTunnelSync(props), { initialProps: p });

describe("usePlannerTunnelSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ tunnelRunning: false });
  });

  it("is inert when the relay is not running", () => {
    render(base);
    expect(tunnelSetPlanState).not.toHaveBeenCalled();
    expect(tunnelEmitPlanStatus).not.toHaveBeenCalled();
  });

  it("pushes the canonical plan + status once the relay is running", () => {
    useAppStore.setState({ tunnelRunning: true });
    render(base);
    expect(tunnelSetPlanState).toHaveBeenCalledTimes(1);
    expect(tunnelEmitPlanStatus).toHaveBeenCalledTimes(1);
    // the cheap header update carries the active stage + its label
    expect(tunnelEmitPlanStatus).toHaveBeenCalledWith(expect.any(String), "goal", "drafting");
  });

  it("stays dark when there is no plan yet (empty sections → null canonical plan)", () => {
    useAppStore.setState({ tunnelRunning: true });
    render({ ...base, savedSections: {} });
    expect(tunnelSetPlanState).not.toHaveBeenCalled();
    expect(tunnelEmitPlanStatus).not.toHaveBeenCalled();
  });
});
