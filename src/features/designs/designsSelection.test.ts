// `setDesignsComp` must be IDEMPOTENT — the store's half of the Design Studio's click cost.
//
// Re-selecting the component that is already selected used to build a new state object, so Zustand
// notified every subscriber and the whole workbench re-rendered for no change. Measured at 103-150 ms
// per repeat click on the live page, with commits, on a graph where the click itself does nothing.
//
// The assertion is on OBJECT IDENTITY, not on the value: Zustand decides whether to notify by comparing
// the state object it gets back, so a setter that returns a fresh object with equal contents is exactly
// as expensive as one that changed something. A test that only checked `designsCompId` would pass
// against the bug.
import { describe, it, expect } from "vitest";
import { useAppStore } from "@/store";

describe("setDesignsComp", () => {
  it("does not replace the state object when the id is unchanged", () => {
    useAppStore.getState().setDesignsComp("alpha");
    const before = useAppStore.getState();
    useAppStore.getState().setDesignsComp("alpha");
    const after = useAppStore.getState();
    expect(after.designsCompId).toBe("alpha");
    expect(after, "a no-op selection must return the SAME state object, or Zustand notifies").toBe(before);
  });

  it("still changes the selection when the id is different", () => {
    useAppStore.getState().setDesignsComp("alpha");
    const before = useAppStore.getState();
    useAppStore.getState().setDesignsComp("beta");
    const after = useAppStore.getState();
    expect(after.designsCompId).toBe("beta");
    expect(after).not.toBe(before);
  });

  it("treats null as a value, so deselecting twice is also a no-op", () => {
    // Clicking empty space deselects; clicking empty space again must not re-render the workbench.
    useAppStore.getState().setDesignsComp(null);
    const before = useAppStore.getState();
    useAppStore.getState().setDesignsComp(null);
    expect(useAppStore.getState()).toBe(before);
  });

  it("still deselects from a real selection", () => {
    useAppStore.getState().setDesignsComp("alpha");
    useAppStore.getState().setDesignsComp(null);
    expect(useAppStore.getState().designsCompId).toBeNull();
  });
});
