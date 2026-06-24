import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";
import { resolveRepoPublic, repoVisibilityKey } from "./slices/plan";

describe("per-repo GitHub visibility (#1227)", () => {
  beforeEach(() => useAppStore.setState({ reposPublic: {}, repoPublic: {} }));

  it("setRepoPublic records the override under the <projectKey>::<repoId> key", () => {
    useAppStore.getState().setRepoPublic("proj-a", "acme/web", true);
    expect(useAppStore.getState().repoPublic[repoVisibilityKey("proj-a", "acme/web")]).toBe(true);
  });

  describe("resolveRepoPublic", () => {
    it("uses the per-repo override when present", () => {
      const repoPublic = { "proj-a::acme/web": true };
      expect(resolveRepoPublic(repoPublic, {}, "proj-a", "acme/web")).toBe(true);
    });

    it("falls back to the project default when there's no override", () => {
      expect(resolveRepoPublic({}, { "proj-a": true }, "proj-a", "acme/api")).toBe(true);
    });

    it("falls back to PRIVATE (false) when neither override nor default is set", () => {
      expect(resolveRepoPublic({}, {}, "proj-a", "acme/api")).toBe(false);
    });

    it("an override of false wins over a public project default", () => {
      const repoPublic = { "proj-a::acme/api": false };
      expect(resolveRepoPublic(repoPublic, { "proj-a": true }, "proj-a", "acme/api")).toBe(false);
    });

    it("keys are project-scoped — a different project's override doesn't leak", () => {
      const repoPublic = { "proj-b::acme/web": true };
      expect(resolveRepoPublic(repoPublic, {}, "proj-a", "acme/web")).toBe(false);
    });
  });

  it("clearPlan purges only this project's per-repo overrides", () => {
    useAppStore.setState({ repoPublic: { "proj-a::acme/web": true, "proj-a::acme/api": false, "proj-b::x/y": true } });
    useAppStore.getState().clearPlan("proj-a");
    expect(useAppStore.getState().repoPublic).toEqual({ "proj-b::x/y": true });
  });
});
