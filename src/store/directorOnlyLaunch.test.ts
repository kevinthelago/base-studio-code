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

describe("the launch does not touch the opt-in Console page", () => {
  it("asks for the console workspace", () => {
    useAppStore.setState({ tabs: [], activeTab: 0 } as never);
    useAppStore.getState().fleetStartProject("p", directorOnlyPlan(), "p", { hubPath: "/h" });
    expect(useAppStore.getState().activeWorkspace).toBe("console");
  });

  it("LEAVES the Console page off — starting a fleet is not consent to re-enable it", () => {
    // THE REGRESSION THIS PINS. Both launch actions were briefly changed to force the console page on,
    // reasoning that `effectiveWorkspace` redirects a console-active workspace to Glance while the page
    // is off, so the pane never mounts. The page is OPT-IN (#2372) and the maintainer keeps it off; a
    // launch may not flip a user preference to suit itself.
    //
    // The premise was false as well: a director ran to 596 transcript lines on 2026-09-04 with the page
    // off, so the redirect is not what stops one mounting. Ref
    // `a-fleet-launch-must-not-turn-the-legacy-console-page-on`.
    useAppStore.setState({ tabs: [], activeTab: 0, showConsolePage: false } as never);
    useAppStore.getState().fleetStartProject("p", directorOnlyPlan(), "p", { hubPath: "/h" });
    expect(useAppStore.getState().showConsolePage,
      "a fleet launch must not turn the Console page on").toBe(false);
  });

  it("and neither does triage", () => {
    useAppStore.setState({ tabs: [], activeTab: 0, showConsolePage: false } as never);
    useAppStore.getState().triageStartProject("p", ["o/web"], "p");
    expect(useAppStore.getState().showConsolePage,
      "a triage launch must not turn the Console page on").toBe(false);
  });

  it("leaves an ALREADY-ON page on — it does not write the flag in either direction", () => {
    useAppStore.setState({ tabs: [], activeTab: 0, showConsolePage: true } as never);
    useAppStore.getState().fleetStartProject("p", directorOnlyPlan(), "p", { hubPath: "/h" });
    expect(useAppStore.getState().showConsolePage).toBe(true);
  });
});
