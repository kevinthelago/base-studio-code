// #3616 — the Design Studio's preview-error scan must PAUSE while the Studio is kept-mounted but hidden,
// or it esbuild-builds + iframe-probes 154 components forever (~40% renderer CPU for a page nobody's on).
//
// `five-graphs-become-rail-workspaces` moved the Studio out of the Planner and onto its own rail
// destination, so the answer is now a WORKSPACE comparison. The inverse of #3616 is the risk this
// rewrite guards: left comparing `projects`/`designs` it would be false forever and the scan would
// never run at all — which looks like a Design Studio with no components rather than like a pinned CPU,
// and so is the quieter of the two failures.
import { describe, it, expect } from "vitest";
import { designStudioVisible } from "@/features/designs/lib/studioVisibility";

describe("designStudioVisible (#3616)", () => {
  it("is true ONLY on the Components workspace", () => {
    expect(designStudioVisible("components")).toBe(true);
  });

  it("is false on every other workspace, so the scan pauses when the Studio is hidden", () => {
    // The kept-mounted Workbench survives a workspace switch, so it is still MOUNTED on each of
    // these — mounted is not showing, which is the whole point of the gate.
    for (const w of ["glance", "console", "projects", "algorithms", "teams", "sounds", "data", "logs", "settings"]) {
      expect(designStudioVisible(w), `${w} must not run the scan`).toBe(false);
    }
  });

  it("ignores the Planner page mode entirely, whatever it lingers on", () => {
    // `projectsPageMode` is persisted independently and can still read "designs" long after the
    // Studio stopped being a Planner tab. It must have no bearing either way — a stale value must
    // neither start the scan off-page nor suppress it on-page.
    expect(designStudioVisible("components", "projects")).toBe(true);
    expect(designStudioVisible("components", undefined)).toBe(true);
    expect(designStudioVisible("projects", "designs")).toBe(false);
    expect(designStudioVisible("glance", "designs")).toBe(false);
  });
});
