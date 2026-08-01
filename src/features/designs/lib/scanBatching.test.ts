// The scan's BATCHED store write (#4132).
//
// The regression this guards is a performance one with a functional shape: the scan used to call
// `setComponentBuildStatus` + `setComponentStateHealth` per component, so a 248-component sweep produced
// ~496 store commits and the Studio re-rendered its whole 248-node graph on every one (measured: 125
// `[render] designs update` commits at ~24ms). `applyComponentScanResults` collapses a batch into ONE
// commit — so the assertion that matters is the COMMIT COUNT, not just the resulting state.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "@/store";
import type { ComponentScanResult } from "./componentScan";

const results = (n: number): ComponentScanResult[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    status: { state: "ok" } as const,
    stateBlanks: [],
  }));

describe("applyComponentScanResults", () => {
  beforeEach(() => {
    useAppStore.setState({ componentBuildStatus: {}, componentStateHealth: {} });
  });

  it("commits ONE store update for a whole batch, not two per component", () => {
    let commits = 0;
    const unsub = useAppStore.subscribe(() => { commits += 1; });
    useAppStore.getState().applyComponentScanResults(results(248));
    unsub();
    expect(commits).toBe(1); // the pre-#4132 path was 496
  });

  it("writes both maps for every entry", () => {
    useAppStore.getState().applyComponentScanResults([
      { id: "a", status: { state: "ok" }, stateBlanks: [] },
      { id: "b", status: { state: "error", kind: "build", message: "boom" }, stateBlanks: ["empty-empty-state"] },
    ]);
    const s = useAppStore.getState();
    expect(s.componentBuildStatus.a).toEqual({ state: "ok" });
    expect(s.componentBuildStatus.b).toEqual({ state: "error", kind: "build", message: "boom" });
    expect(s.componentStateHealth.a).toEqual([]);
    expect(s.componentStateHealth.b).toEqual(["empty-empty-state"]);
  });

  it("upserts — a later batch overwrites an earlier verdict and CLEARS a stale blank", () => {
    const st = useAppStore.getState();
    st.applyComponentScanResults([{ id: "a", status: { state: "error", kind: "runtime", message: "x" }, stateBlanks: ["empty-loading-state"] }]);
    st.applyComponentScanResults([{ id: "a", status: { state: "ok" }, stateBlanks: [] }]);
    expect(useAppStore.getState().componentBuildStatus.a).toEqual({ state: "ok" });
    // `[]` is meaningful: a fixed component must lose its prior blank badge.
    expect(useAppStore.getState().componentStateHealth.a).toEqual([]);
  });

  it("preserves entries a batch does not mention", () => {
    const st = useAppStore.getState();
    st.applyComponentScanResults([{ id: "keep", status: { state: "ok" }, stateBlanks: [] }]);
    st.applyComponentScanResults([{ id: "new", status: { state: "ok" }, stateBlanks: [] }]);
    expect(Object.keys(useAppStore.getState().componentBuildStatus).sort()).toEqual(["keep", "new"]);
  });

  it("an empty batch is a no-op — it must not commit an identity-breaking update", () => {
    const before = useAppStore.getState().componentBuildStatus;
    let commits = 0;
    const unsub = useAppStore.subscribe(() => { commits += 1; });
    useAppStore.getState().applyComponentScanResults([]);
    unsub();
    expect(commits).toBe(0);
    expect(useAppStore.getState().componentBuildStatus).toBe(before); // same reference
  });
});
