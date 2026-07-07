// useNavHistory (#2492) — the app-wide mouse back/forward history over workspace + planner page +
// glance/org drills. Drives the REAL store; each test restores the slice it touched.
import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAppStore } from "@/store";
import { useNavHistory } from "./useNavHistory";

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
      activeWorkspace: "projects",
      projectsPageMode: "projects",
      glanceDrill: null,
      orgDrill: null,
    });
  });

  it("mouse back exits an org pool drill; forward re-enters it (#2492)", () => {
    useAppStore.setState({ projectsPageMode: "org" });
    const hook = renderHook(() => useNavHistory());
    act(() => useAppStore.getState().setOrgDrill("pool:engineer"));
    expect(useAppStore.getState().orgDrill).toBe("pool:engineer");

    back();
    expect(useAppStore.getState().orgDrill).toBeNull();
    expect(useAppStore.getState().projectsPageMode).toBe("org"); // still on the Org page

    forward();
    expect(useAppStore.getState().orgDrill).toBe("pool:engineer");
    hook.unmount();
  });

  it("planner page switches join the history (Projects ↔ Org)", () => {
    const hook = renderHook(() => useNavHistory());
    act(() => useAppStore.getState().setProjectsPageMode("org"));
    act(() => useAppStore.getState().setOrgDrill("pool:x"));

    back(); // drill out
    expect(useAppStore.getState().orgDrill).toBeNull();
    expect(useAppStore.getState().projectsPageMode).toBe("org");
    back(); // page back
    expect(useAppStore.getState().projectsPageMode).toBe("projects");
    hook.unmount();
  });

  it("glance drill + workspace switches keep working (regression)", () => {
    const hook = renderHook(() => useNavHistory());
    act(() => useAppStore.getState().setWorkspace("glance"));
    act(() => useAppStore.getState().setGlanceDrill("proj-1"));

    back();
    expect(useAppStore.getState().glanceDrill).toBeNull();
    expect(useAppStore.getState().activeWorkspace).toBe("glance");
    back();
    expect(useAppStore.getState().activeWorkspace).toBe("projects");
    forward();
    expect(useAppStore.getState().activeWorkspace).toBe("glance");
    hook.unmount();
  });

  it("back at the start of the stack is a no-op", () => {
    const hook = renderHook(() => useNavHistory());
    back();
    expect(useAppStore.getState().activeWorkspace).toBe("projects");
    expect(useAppStore.getState().projectsPageMode).toBe("projects");
    hook.unmount();
  });

  it("an org drill on another workspace does not pollute the history", () => {
    const hook = renderHook(() => useNavHistory());
    act(() => useAppStore.getState().setWorkspace("glance"));
    // A stale org drill set while Glance is showing is not a location change on Glance...
    act(() => useAppStore.getState().setOrgDrill("pool:stale"));
    back(); // ...so one back returns to the planner, not to a phantom drill entry.
    expect(useAppStore.getState().activeWorkspace).toBe("projects");
    hook.unmount();
  });
});
