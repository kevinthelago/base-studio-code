// #3610 — the persisted snapshot must NOT carry the component library.
//
// `components` is a ~592 KB blob loaded fresh from `bsc ui` at boot (hydrateComponents). Zustand `persist`
// re-`JSON.stringify`s the whole partialized snapshot on EVERY store write, so persisting `components`
// re-serialized ~600 KB on the main thread on every unrelated tick — freezing the app. This guards that
// it stays out (and that genuine UI/settings state stays in).
import { describe, it, expect } from "vitest";
import { persistedState } from "./persist";
import { useAppStore } from "@/store";

describe("persistedState — the persist allowlist (#3610)", () => {
  it("does NOT persist the component library (it re-hydrates from bsc at boot)", () => {
    expect("components" in persistedState(useAppStore.getState())).toBe(false);
  });

  it("a full 600 KB component library added to the store does NOT grow the persisted snapshot", () => {
    // The direct proof of the fix, independent of any seed sizes: inject a fully-hydrated library and
    // show the serialized snapshot is byte-for-byte unchanged — i.e. the heavy blob no longer rides
    // along on every write. Before the fix this delta was ~600 KB per write.
    const before = JSON.stringify(persistedState(useAppStore.getState())).length;
    const fatLibrary = Array.from({ length: 154 }, (_, i) => ({ id: `c${i}`, srcText: "x".repeat(4000) }));
    useAppStore.setState({ components: fatLibrary as never });
    const after = JSON.stringify(persistedState(useAppStore.getState())).length;
    expect(after).toBe(before);
    expect("components" in persistedState(useAppStore.getState())).toBe(false);
  });

  it("still persists genuine UI + settings + library state (not an over-broad deletion)", () => {
    const snap = persistedState(useAppStore.getState());
    // A representative field from every domain that MUST survive a restart.
    for (const key of [
      "activeWorkspace", "tabs", "keybindings",           // shell / console UI
      "githubToken", "githubState",                        // github
      "skills", "personas", "teams", "blueprints",         // libraries
      "planFleet", "planStages",                           // planner
      "kits", "kitUsage", "kitDispatches",                 // kit state (kept: small caches + durable queue)
    ]) {
      expect(key in snap).toBe(true);
    }
  });

  it("returns a plain projection, not the whole store (no store methods leak in)", () => {
    const snap = persistedState(useAppStore.getState()) as Record<string, unknown>;
    expect(typeof snap.setWorkspace).toBe("undefined");
    expect(typeof snap.navigate).toBe("undefined");
  });
});
