import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { orderTabs, usePageTabs } from "./usePageTabs";
import { useAppStore } from "@/store";
import type { TabItem } from "@/shared/ui/layouts/TabBar";

const DEFS: TabItem[] = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
];

describe("orderTabs", () => {
  it("returns defs unchanged when there's no persisted order", () => {
    expect(orderTabs(DEFS, undefined).map(t => t.id)).toEqual(["a", "b", "c"]);
    expect(orderTabs(DEFS, []).map(t => t.id)).toEqual(["a", "b", "c"]);
  });

  it("applies the persisted order (front tab = the user's preference)", () => {
    expect(orderTabs(DEFS, ["c", "a", "b"]).map(t => t.id)).toEqual(["c", "a", "b"]);
  });

  it("appends new defs not present in the persisted order", () => {
    // Only a,c remembered; b is new → appended after the remembered ones.
    expect(orderTabs(DEFS, ["c", "a"]).map(t => t.id)).toEqual(["c", "a", "b"]);
  });

  it("ignores stale ids in the persisted order", () => {
    expect(orderTabs(DEFS, ["gone", "b", "a", "stale"]).map(t => t.id)).toEqual(["b", "a", "c"]);
  });
});

// The uncontrolled active page persists per pageKey (#2254) — so a workspace reopens
// on the last-viewed Page across an in-session remount and across restart.
describe("usePageTabs — persisted active page (#2254)", () => {
  beforeEach(() => useAppStore.setState({ activePageTab: {}, pageTabOrder: {}, detachedSections: {} }));

  it("defaults to the front tab when nothing is persisted", () => {
    const { result } = renderHook(() => usePageTabs("k", DEFS));
    expect(result.current.activeId).toBe("a");
    // No memory written until the user actually selects.
    expect(useAppStore.getState().activePageTab.k).toBeUndefined();
  });

  it("persists the selected page to the store", async () => {
    const { result } = renderHook(() => usePageTabs("k", DEFS));
    await act(async () => { result.current.select("c"); });
    expect(result.current.activeId).toBe("c");
    expect(useAppStore.getState().activePageTab.k).toBe("c");
  });

  it("restores the persisted page on a fresh mount (in-session remount / restart)", () => {
    useAppStore.setState({ activePageTab: { k: "b" } });
    const { result } = renderHook(() => usePageTabs("k", DEFS));
    expect(result.current.activeId).toBe("b");
  });

  it("namespaces the memory per pageKey", async () => {
    const { result: r1 } = renderHook(() => usePageTabs("one", DEFS));
    const { result: r2 } = renderHook(() => usePageTabs("two", DEFS));
    await act(async () => { r1.current.select("c"); });
    expect(r1.current.activeId).toBe("c");
    expect(r2.current.activeId).toBe("a"); // untouched — different page
  });

  it("heals a stale persisted id to the front tab", () => {
    useAppStore.setState({ activePageTab: { k: "gone" } });
    const { result } = renderHook(() => usePageTabs("k", DEFS));
    expect(result.current.activeId).toBe("a");
    expect(useAppStore.getState().activePageTab.k).toBe("a"); // self-healed + re-persisted
  });

  it("leaves the store alone in controlled mode", async () => {
    let active = "b";
    const setActive = (id: string) => { active = id; };
    const { result } = renderHook(() => usePageTabs("k", DEFS, { activeId: active, setActive }));
    await act(async () => { result.current.select("c"); });
    expect(active).toBe("c");
    expect(useAppStore.getState().activePageTab.k).toBeUndefined(); // never touched
  });
});
