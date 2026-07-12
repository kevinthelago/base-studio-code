// Unit tests for the kit-change approval store actions (#2944). Auto-apply is a global toggle (OFF by
// default), surfaced in Planner settings; `approveKitChange` marks a change for the drain, per-change.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";

describe("kit-change approval store (#2944)", () => {
  beforeEach(() => {
    useAppStore.setState({ autoApplyKitChanges: false, approvedChangeIds: [] });
  });

  it("auto-apply defaults OFF (the user approves each change)", () => {
    expect(useAppStore.getState().autoApplyKitChanges).toBe(false);
  });

  it("setAutoApplyKitChanges toggles it", () => {
    useAppStore.getState().setAutoApplyKitChanges(true);
    expect(useAppStore.getState().autoApplyKitChanges).toBe(true);
    useAppStore.getState().setAutoApplyKitChanges(false);
    expect(useAppStore.getState().autoApplyKitChanges).toBe(false);
  });

  it("approveKitChange records the change id, idempotently, without disturbing others", () => {
    const { approveKitChange } = useAppStore.getState();
    approveKitChange("chg-1");
    expect(useAppStore.getState().approvedChangeIds).toEqual(["chg-1"]);
    approveKitChange("chg-1"); // idempotent — no duplicate
    expect(useAppStore.getState().approvedChangeIds).toEqual(["chg-1"]);
    approveKitChange("chg-2");
    expect(useAppStore.getState().approvedChangeIds).toEqual(["chg-1", "chg-2"]);
  });
});
