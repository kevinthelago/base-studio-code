// Unit tests for the kit-change approval store actions (#2944/#2951/#2968). Auto-apply is a global
// toggle (ON by default #2968 — designer changes apply without confirmation), surfaced in Planner
// settings; `dismissKitChange` removes ALL of a change's dispatches at once (the banner's
// Approve/Dismiss both call it, so confirming actually clears it).
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import { createComponentsSlice } from "./store";
import type { Dispatch } from "@/features/designs";

// A minimal dispatch — the tests only read `projectKey` + `change.id`, so cast past the rest.
const dispatch = (changeId: string, projectKey: string): Dispatch => ({
  projectKey,
  change: { id: changeId, class: "additive", component: "Button", summary: "changed" },
} as unknown as Dispatch);

describe("kit-change approval store (#2944/#2951/#2968)", () => {
  beforeEach(() => {
    useAppStore.setState({ kitDispatches: [] });
  });

  it("auto-apply defaults ON — designer changes apply without confirmation (#2968)", () => {
    // Assert the SHIPPED default off a fresh slice (not the shared singleton the other tests mutate).
    const fresh = createComponentsSlice((() => {}) as never, (() => ({})) as never, undefined as never);
    expect(fresh.autoApplyKitChanges).toBe(true);
  });

  it("setAutoApplyKitChanges toggles it", () => {
    useAppStore.getState().setAutoApplyKitChanges(true);
    expect(useAppStore.getState().autoApplyKitChanges).toBe(true);
    useAppStore.getState().setAutoApplyKitChanges(false);
    expect(useAppStore.getState().autoApplyKitChanges).toBe(false);
  });

  it("enabling auto-apply CLEARS the pending queue; disabling leaves it (#2975)", () => {
    useAppStore.setState({ kitDispatches: [dispatch("chg-1", "proj-a"), dispatch("chg-2", "proj-b")] });
    useAppStore.getState().setAutoApplyKitChanges(true);
    expect(useAppStore.getState().kitDispatches).toHaveLength(0); // existing requests ignored
    // Disabling must NOT wipe a freshly-queued request.
    useAppStore.setState({ kitDispatches: [dispatch("chg-3", "proj-a")] });
    useAppStore.getState().setAutoApplyKitChanges(false);
    expect(useAppStore.getState().kitDispatches).toHaveLength(1);
  });

  it("hydrateComponents drops the persisted queue on boot when auto-apply is ON, keeps it when OFF (#2975)", async () => {
    useAppStore.setState({ autoApplyKitChanges: true, kitDispatches: [dispatch("chg-1", "proj-a")] });
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().kitDispatches).toHaveLength(0); // ON ⇒ ignored on boot

    useAppStore.setState({ autoApplyKitChanges: false, kitDispatches: [dispatch("chg-2", "proj-a")] });
    await useAppStore.getState().hydrateComponents();
    expect(useAppStore.getState().kitDispatches).toHaveLength(1); // OFF ⇒ the review queue survives
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
