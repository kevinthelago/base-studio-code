import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";

describe("updateDraftProject (#1222)", () => {
  beforeEach(() => useAppStore.setState({ localDraftProjects: {} }));

  it("patches the draft's title in place, keyed by the frozen key", () => {
    useAppStore.getState().addDraftProject("my-app", { title: "My app", pitch: "p", createdAt: 1 });
    useAppStore.getState().updateDraftProject("my-app", { title: "Renamed app" });
    expect(useAppStore.getState().localDraftProjects["my-app"]).toEqual({ title: "Renamed app", pitch: "p", createdAt: 1 });
  });

  it("persists across a reopen (the record is what reopenDraft reads)", () => {
    useAppStore.getState().addDraftProject("k", { title: "Old", pitch: "", createdAt: 0 });
    useAppStore.getState().updateDraftProject("k", { title: "New" });
    // A later read of the record (as reopenDraft does) sees the new title — the bug was this stayed "Old".
    expect(useAppStore.getState().localDraftProjects["k"].title).toBe("New");
  });

  it("no-ops when the draft is gone (no resurrection)", () => {
    useAppStore.getState().updateDraftProject("ghost", { title: "x" });
    expect(useAppStore.getState().localDraftProjects["ghost"]).toBeUndefined();
  });
});
