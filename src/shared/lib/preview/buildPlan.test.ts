import { describe, it, expect } from "vitest";
import { resolveBuildPlan } from "./buildPlan";

describe("resolveBuildPlan (#2632 — the verify-build's stack → commands)", () => {
  it("installs + builds, and prefers the framework's own preview server when present", () => {
    const plan = resolveBuildPlan({ scripts: { build: "vite build", preview: "vite preview" } });
    expect(plan).toEqual({ build: ["npm ci || npm install", "npm run build"], serve: "npm run preview", kind: "web" });
  });

  it("falls back to a static serve of the build output when there's no preview script", () => {
    expect(resolveBuildPlan({ scripts: { build: "react-scripts build" } })?.serve).toBe("npx --yes serve -s dist");
  });

  it("returns null when there's no build script (not a previewable web app here)", () => {
    expect(resolveBuildPlan({ scripts: { start: "node index.js" } })).toBeNull();
    expect(resolveBuildPlan(null)).toBeNull();
    expect(resolveBuildPlan({})).toBeNull();
  });
});
