import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { navScreens, useScreenDescriptor, type ScreenDescriptor } from "@/shared/hooks/useScreenDescriptor";

const view = (over: Partial<ScreenDescriptor> = {}): ScreenDescriptor => ({
  workspace: "glance",
  drill: [],
  selection: null,
  targets: [],
  ...over,
});

describe("useScreenDescriptor", () => {
  it("publishes what COMMITTED and follows every re-render, then retracts on unmount", () => {
    const { rerender, unmount } = renderHook((d: ScreenDescriptor) => useScreenDescriptor(d), {
      initialProps: view({ selection: "a" }),
    });
    expect(navScreens.read("glance")?.selection).toBe("a");
    rerender(view({ selection: "b" }));
    expect(navScreens.read("glance")?.selection).toBe("b");
    unmount();
    expect(navScreens.read("glance")).toBeUndefined();
  });

  // A remount publishes before its predecessor's cleanup runs. Deleting unconditionally on unmount would
  // leave the workspace with NO descriptor while it is on screen, and every drill would then error as
  // "publishes nothing to drill or select".
  it("an unmount does not retract a descriptor another mount has published since", () => {
    const first = renderHook(() => useScreenDescriptor(view({ selection: "old" })));
    const second = renderHook(() => useScreenDescriptor(view({ selection: "new" })));
    first.unmount();
    expect(navScreens.read("glance")?.selection).toBe("new");
    second.unmount();
    expect(navScreens.read("glance")).toBeUndefined();
  });

  it("a null descriptor publishes nothing", () => {
    renderHook(() => useScreenDescriptor(null));
    expect(navScreens.read("glance")).toBeUndefined();
  });

  it("keeps the tabs a workspace last rendered", () => {
    navScreens.publishTabs("algorithms", ["rust", "typescript"]);
    expect(navScreens.tabsOf("algorithms")).toEqual(["rust", "typescript"]);
    navScreens.publishTabs("algorithms", ["rust"]);
    expect(navScreens.tabsOf("algorithms")).toEqual(["rust"]);
  });
});
