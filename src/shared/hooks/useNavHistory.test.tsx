// useNavHistory (#2492) — the app-wide mouse back/forward history over workspace + planner page +
// glance/org drills. Drives the REAL store; each test restores the slice it touched.
//
// NOTE (#2515): every store setter RETURNS a Promise under the persist middleware (zustand v5's
// wrapped `set` returns `setItem()`), so an act callback must use a braced body — a brace-less
// `act(() => setX(...))` leaks that promise, React treats the act as async, and the un-awaited
// scope defers the hook's push effect past the assertions.
import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAppStore } from "@/store";
import { useNavHistory } from "@/shared/hooks/useNavHistory";

const press = (button: 3 | 4) => {
  act(() => {
    window.dispatchEvent(new MouseEvent("mouseup", { button, bubbles: true }));
  });
};
const back = () => press(3);
const forward = () => press(4);

describe("useNavHistory", () => {
  beforeEach(() => {
    useAppStore.setState({
      // The Planner is gone (`delete-the-planner-ui-keep-the-planner`); history steps the ACTIVE
      // workspace's page tab now, so the fixture starts on a tabbed graph workspace.
      activeWorkspace: "algorithms",
      activePageTab: {},
      glanceDrill: null,
      teamsDrill: null,
    });
  });

  it("mouse back exits a team pool drill; forward re-enters it (#2492)", () => {
    // Teams is its own WORKSPACE now, so the drill lives there rather than on a Planner page.
    useAppStore.setState({ activeWorkspace: "teams" });
    const hook = renderHook(() => useNavHistory());
    act(() => { useAppStore.getState().setTeamsDrill("pool:engineer"); });
    expect(useAppStore.getState().teamsDrill).toBe("pool:engineer");

    back();
    expect(useAppStore.getState().teamsDrill).toBeNull();
    expect(useAppStore.getState().activeWorkspace).toBe("teams"); // still on Teams

    forward();
    expect(useAppStore.getState().teamsDrill).toBe("pool:engineer");
    hook.unmount();
  });

  it("PAGE TAB switches join the history, for any tabbed workspace", () => {
    // This used to be "planner page switches (Projects ↔ Teams)". History steps the ACTIVE
    // workspace's tab now (`delete-the-planner-ui-keep-the-planner`), which is the general form —
    // the Planner's page mode was one workspace's private enum.
    useAppStore.setState({ activeWorkspace: "algorithms", activePageTab: { algorithms: "typescript" } });
    const hook = renderHook(() => useNavHistory());
    act(() => { useAppStore.getState().setActivePageTab("algorithms", "rust"); });
    expect(useAppStore.getState().activePageTab.algorithms).toBe("rust");

    back();
    expect(useAppStore.getState().activePageTab.algorithms).toBe("typescript");
    hook.unmount();
  });

  it("glance drill + workspace switches keep working (regression)", () => {
    const hook = renderHook(() => useNavHistory());
    act(() => { useAppStore.getState().setWorkspace("glance"); });
    act(() => { useAppStore.getState().setGlanceDrill("proj-1"); });

    back();
    expect(useAppStore.getState().glanceDrill).toBeNull();
    expect(useAppStore.getState().activeWorkspace).toBe("glance");
    back();
    expect(useAppStore.getState().activeWorkspace).toBe("algorithms");
    forward();
    expect(useAppStore.getState().activeWorkspace).toBe("glance");
    hook.unmount();
  });

  it("back at the start of the stack is a no-op", () => {
    const hook = renderHook(() => useNavHistory());
    back();
    expect(useAppStore.getState().activeWorkspace).toBe("algorithms");
    hook.unmount();
  });

  it("an org drill on another workspace does not pollute the history", () => {
    const hook = renderHook(() => useNavHistory());
    act(() => { useAppStore.getState().setWorkspace("glance"); });
    // A stale org drill set while Glance is showing is not a location change on Glance...
    act(() => { useAppStore.getState().setTeamsDrill("pool:stale"); });
    back(); // ...so one back returns to the planner, not to a phantom drill entry.
    expect(useAppStore.getState().activeWorkspace).toBe("algorithms");
    hook.unmount();
  });
});

describe("useNavHistory — event delivery (#3946)", () => {
  beforeEach(() => {
    useAppStore.setState({
      activeWorkspace: "algorithms", activePageTab: {}, glanceDrill: null, teamsDrill: null,
    });
  });

  /** Dispatch from a real element so the event actually propagates through a tree. */
  const pressFrom = (el: Element, type: "mouseup" | "pointerup", button: 3 | 4) => {
    act(() => { el.dispatchEvent(new MouseEvent(type, { button, bubbles: true })); });
  };

  it("navigates even when an ancestor calls stopPropagation — the capture-phase fix", () => {
    // This is the bug: the listeners were BUBBLE phase, so anything between the target and `window`
    // could swallow the gesture silently. The app is full of such handlers (Glance canvas, the morph
    // overlays, xterm). Capture runs before all of them.
    const host = document.createElement("div");
    const child = document.createElement("div");
    host.appendChild(child);
    document.body.appendChild(host);
    host.addEventListener("mouseup", (e) => e.stopPropagation());

    renderHook(() => useNavHistory());
    act(() => { useAppStore.setState({ activeWorkspace: "glance" }); });
    expect(useAppStore.getState().activeWorkspace).toBe("glance");

    pressFrom(child, "mouseup", 3);
    expect(useAppStore.getState().activeWorkspace).toBe("algorithms");

    host.remove();
  });

  it("also accepts pointerup, which carries the same button values", () => {
    renderHook(() => useNavHistory());
    act(() => { useAppStore.setState({ activeWorkspace: "glance" }); });
    pressFrom(document.body, "pointerup", 3);
    expect(useAppStore.getState().activeWorkspace).toBe("algorithms");
  });

  it("ignores the ordinary buttons — left/middle/right must never navigate", () => {
    renderHook(() => useNavHistory());
    act(() => { useAppStore.setState({ activeWorkspace: "glance" }); });
    for (const button of [0, 1, 2]) {
      act(() => { document.body.dispatchEvent(new MouseEvent("mouseup", { button, bubbles: true })); });
    }
    expect(useAppStore.getState().activeWorkspace).toBe("glance");
  });
});
