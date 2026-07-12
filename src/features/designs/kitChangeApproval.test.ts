// Unit tests for the kit-change approval store actions (#2944/#2951). Auto-apply is a global toggle
// (OFF by default), surfaced in Planner settings; `dismissKitChange` removes ALL of a change's
// dispatches at once (the banner's Approve/Dismiss both call it, so confirming actually clears it).
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import type { Dispatch } from "@/features/designs";

// A minimal dispatch — the tests only read `projectKey` + `change.id`, so cast past the rest.
const dispatch = (changeId: string, projectKey: string): Dispatch => ({
  projectKey,
  change: { id: changeId, class: "additive", component: "Button", summary: "changed" },
} as unknown as Dispatch);

describe("kit-change approval store (#2944/#2951)", () => {
  beforeEach(() => {
    useAppStore.setState({ autoApplyKitChanges: false, kitDispatches: [] });
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

  it("dismissKitChange removes ALL of a change's dispatches across consumers, leaving others (#2951)", () => {
    useAppStore.setState({
      kitDispatches: [dispatch("chg-1", "proj-a"), dispatch("chg-1", "proj-b"), dispatch("chg-2", "proj-a")],
    });
    useAppStore.getState().dismissKitChange("chg-1");
    const left = useAppStore.getState().kitDispatches;
    expect(left).toHaveLength(1);
    expect(left[0].change.id).toBe("chg-2");
  });
});
