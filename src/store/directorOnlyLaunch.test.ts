// Does a DIRECTOR-ONLY plan actually launch a director?
//
// `bsc fleet director new` builds the smallest honest FleetPlan (a director, no streams) and hands it
// to `fleetStartProject`. In the field that produced no pane and no roster row, while the ack said it
// had worked — so this drives the REAL store action with that exact plan and asserts on what it
// returns, which is the evidence the ack should have been reading all along.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { directorOnlyPlan } from "@/app/fleetDirectorBridge";

beforeEach(() => {
  useAppStore.setState({ tabs: [], activeTab: 0 } as never);
});

describe("a director-only plan", () => {
  it("returns a roster row naming the director's pane", () => {
    const rows = useAppStore
      .getState()
      .fleetStartProject("village-animal-hospital", directorOnlyPlan(), "village-animal-hospital", {
        hubPath: "/home/x/.base-studio-code/projects/village-animal-hospital",
      });
    // The row format is `<paneId>\tdirector\t-\t-\tdirector`.
    expect(rows.some((r) => r.startsWith("village-animal-hospital:director\t")), 
      `fleetStartProject returned ${rows.length} row(s): ${JSON.stringify(rows)}`).toBe(true);
  });

  it("creates a tab holding that pane", () => {
    useAppStore.getState().fleetStartProject("p", directorOnlyPlan(), "p", { hubPath: "/h" });
    const tabs = useAppStore.getState().tabs;
    expect(tabs.length, "a director-only launch must produce a tab").toBeGreaterThan(0);
  });
});

describe("…but the launch is only VISIBLE if the Console page is on", () => {
  it("asks for the console workspace", () => {
    useAppStore.setState({ tabs: [], activeTab: 0 } as never);
    useAppStore.getState().fleetStartProject("p", directorOnlyPlan(), "p", { hubPath: "/h" });
    expect(useAppStore.getState().activeWorkspace).toBe("console");
  });

  it("and that request is REDIRECTED AWAY when the Console page is off — which is the default", async () => {
    // THE MECHANISM. `fleetStartProject` sets `activeWorkspace: "console"` to bring its tab on screen,
    // but the Console page is opt-in (#2372) and `effectiveWorkspace` sends a console-active workspace
    // to Glance when it is off. The pane therefore never renders, `TerminalView` never mounts, and
    // `pty_create` never runs — so a launch that succeeded in the STORE produces no shell and no agent.
    const { effectiveWorkspace } = await import("@/app/registry");
    expect(effectiveWorkspace("console", false)).toBe("glance");
    expect(effectiveWorkspace("console", true)).toBe("console");
  });

  it("turns the Console page ON, so a launch it just made is reachable", () => {
    // The fix. A launch the user cannot see is not a launch: the panes exist in the store and nothing
    // ever mounts them. Enabling it here is narrow — it happens only when a fleet is deliberately
    // started — and it is what makes `activeWorkspace: "console"` mean anything.
    useAppStore.setState({ tabs: [], activeTab: 0, showConsolePage: false } as never);
    useAppStore.getState().fleetStartProject("p", directorOnlyPlan(), "p", { hubPath: "/h" });
    expect(useAppStore.getState().showConsolePage, 
      "a fleet launch must make its own tab reachable").toBe(true);
  });
});
