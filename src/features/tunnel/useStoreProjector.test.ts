// useStoreProjector (#2498) — wiring test: every scoped domain publishes from the live store
// while the relay runs, and the whole projector is dark when it doesn't. The payload SHAPES are
// pinned by the pure selector tests (lib/storeProjections.test.ts); this guards the mount-once
// hook actually feeds them and stays gated on tunnelRunning.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAppStore } from "@/store";

vi.mock("./lib/tunnelDomains", () => ({
  publishTunnelDomain: vi.fn(),
  resetTunnelDomains: vi.fn(),
}));
vi.mock("./lib/alertHub", () => ({
  recordTunnelAlerts: vi.fn(),
  seedTunnelAlerts: vi.fn(),
}));
// The glance data hooks poll GitHub/errordb/plan.db — inert STABLE fixtures here (fresh arrays
// each render would re-fire the glance effect); their behavior is the glance feature's tests.
vi.mock("@/features/glance", () => {
  const projects = [{ id: "demo", name: "Demo", role: "service", health: "off", activity: "building" }];
  const faults = { demo: { level: "error", title: "boom", count: 2 } };
  return {
    useGlanceProjects: () => projects,
    useGlanceFaults: () => faults,
    useProjectFleet: () => null,
  };
});
vi.mock("@/features/skills", () => ({
  loadPendingLessons: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/features/mcp", () => ({
  resolveAllInstalledMcp: (servers: { id: string }[]) => servers,
}));
vi.mock("@/shared/lib/fleet/useCoordLog", () => ({
  readCoordState: vi.fn().mockResolvedValue(null),
}));
// The security audit poll reads the audit log; stub it (preserving the module's
// other exports the store uses) so the poll is deterministic — profiles/assignments publish on mount.
vi.mock("@/shared/lib/core/bsc", async (orig) => ({
  ...(await orig<typeof import("@/shared/lib/core/bsc")>()),
  bscJson: vi.fn().mockResolvedValue([]),
}));

import { useStoreProjector } from "./useStoreProjector";
import { publishTunnelDomain, resetTunnelDomains } from "./lib/tunnelDomains";

const publishedDomains = () =>
  new Set(vi.mocked(publishTunnelDomain).mock.calls.map(([domain]) => domain));

describe("useStoreProjector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ tunnelRunning: false });
  });

  it("is dark while the relay is down", () => {
    renderHook(() => useStoreProjector());
    expect(publishTunnelDomain).not.toHaveBeenCalled();
  });

  it("publishes every store-resident domain once the relay runs", () => {
    useAppStore.setState({ tunnelRunning: true });
    renderHook(() => useStoreProjector());
    // `plan` is planner-published (usePlannerTunnelSync) and `alerts` flows through the hub —
    // everything else projects straight from the store on mount (security too — its audit poll
    // enriches later, but profiles/assignments publish immediately, #2530).
    expect(publishedDomains()).toEqual(new Set([
      "glance", "org", "blueprints", "skills", "components", "themes", "automations", "mcp", "security",
    ]));
    expect(resetTunnelDomains).toHaveBeenCalledTimes(1); // fresh run → re-send cache cleared
  });

  it("feeds the glance domain the same merged project/fault sources the desktop reads", () => {
    useAppStore.setState({ tunnelRunning: true, glanceDrill: null });
    renderHook(() => useStoreProjector());
    const glance = vi.mocked(publishTunnelDomain).mock.calls.find(([d]) => d === "glance")?.[1];
    expect(glance).toMatchObject({
      projects: [{ id: "demo", health: "error", reason: "boom", faults: 2 }],
      drill: null,
      drillFleet: null,
    });
  });

  it("re-publishes a domain when its store slice changes", () => {
    useAppStore.setState({ tunnelRunning: true });
    renderHook(() => useStoreProjector());
    vi.mocked(publishTunnelDomain).mockClear();
    // Braced body (#2515): persist makes setState return a Promise; leaking it into act defers
    // the projector effect past the assertion (see useNavHistory.test.tsx).
    act(() => { useAppStore.setState({ kitTheme: "contrast" }); });
    expect(publishedDomains()).toEqual(new Set(["themes"]));
  });
});
