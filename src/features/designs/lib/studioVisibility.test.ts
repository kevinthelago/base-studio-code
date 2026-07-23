// #3616 — the Design Studio's preview-error scan must PAUSE while the Studio is kept-mounted but hidden,
// or it esbuild-builds + iframe-probes 154 components forever (~40% renderer CPU for a page nobody's on).
import { describe, it, expect } from "vitest";
import { designStudioVisible } from "./studioVisibility";

describe("designStudioVisible (#3616)", () => {
  it("is true ONLY on the designs page of the projects workspace", () => {
    expect(designStudioVisible("projects", "designs")).toBe(true);
  });

  it("is false when the projects workspace shows a different page (scan pauses)", () => {
    expect(designStudioVisible("projects", "algorithms")).toBe(false);
    expect(designStudioVisible("projects", "teams")).toBe(false);
    expect(designStudioVisible("projects", "projects")).toBe(false);
  });

  it("is false when another workspace is active, even if projectsPageMode is still 'designs'", () => {
    // The kept-mounted Workbench survives a workspace switch, so `projectsPageMode` can linger on
    // "designs" while the user is on Glance/Console — the scan must NOT run then.
    expect(designStudioVisible("glance", "designs")).toBe(false);
    expect(designStudioVisible("console", "designs")).toBe(false);
  });

  it("is false when projectsPageMode is undefined (workspace hasn't picked a page)", () => {
    expect(designStudioVisible("projects", undefined)).toBe(false);
  });
});
