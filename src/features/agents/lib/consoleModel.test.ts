import { describe, it, expect } from "vitest";
import { deriveConsoles } from "./consoleModel";

describe("deriveConsoles (#1643)", () => {
  it("builds one console per tab with a pane per grid cell", () => {
    const consoles = deriveConsoles({
      tabs: [{ name: "w", layout: "2×2" }],
      paneNames: {}, disabledPanes: {}, paneProfiles: {}, activeRepoName: "acme/app",
    });
    expect(consoles).toHaveLength(1);
    expect(consoles[0]).toMatchObject({ id: "t0", name: "w", repo: "acme/app", status: "running" });
    expect(consoles[0].panes.map((p) => p.id)).toEqual(["t0p0", "t0p1", "t0p2", "t0p3"]);
    // unassigned panes default to the safe Sandboxed profile
    expect(consoles[0].panes.every((p) => p.profileId === "pf_sandbox")).toBe(true);
  });

  it("skips disabled panes and applies pane names + assigned profiles", () => {
    const consoles = deriveConsoles({
      tabs: [{ name: "w", layout: "1×3" }],
      paneNames: { 0: { 0: "@scratch" } },
      disabledPanes: { t0p1: true },
      paneProfiles: { t0p0: "pf_build" },
      activeRepoName: "acme/app",
    });
    const ids = consoles[0].panes.map((p) => p.id);
    expect(ids).toEqual(["t0p0", "t0p2"]); // t0p1 dropped
    expect(consoles[0].panes[0]).toMatchObject({ agent: "@scratch", profileId: "pf_build" });
    expect(consoles[0].panes[1].agent).toBe("pane 3"); // fallback name (1-indexed)
  });

  it("falls back to a dash repo and treats a malformed layout as 1×1", () => {
    const consoles = deriveConsoles({
      tabs: [{ name: "w", layout: "nope" }],
      paneNames: {}, disabledPanes: {}, paneProfiles: {}, activeRepoName: null,
    });
    expect(consoles[0].repo).toBe("—");
    expect(consoles[0].panes.map((p) => p.id)).toEqual(["t0p0"]);
  });
});
