// #3610 / #4086 — the persisted snapshot must NOT carry a `bsc`-owned library.
//
// Zustand `persist` re-`JSON.stringify`s the whole partialized snapshot on EVERY store write. #3610
// found `components` (~592 KB) riding along on every unrelated tick and freezing the app; #4086 found
// the same shape in `blueprints` (395 KB), `skills` (71 KB), `personas` (33 KB) and `teams` (6 KB) —
// together 96% of a 519 KB file. Each is REPLACED from its own SQLite store at boot, so the persisted
// copy was a second source that could only drift.
//
// These guard that they stay out, and that genuine UI/settings state stays in.
import { describe, it, expect } from "vitest";
import { persistedState } from "./persist";
import { useAppStore } from "@/store";

describe("persistedState — the persist allowlist (#3610)", () => {
  it("does NOT persist any bsc-owned library (each re-hydrates from its store at boot)", () => {
    const snap = persistedState(useAppStore.getState());
    // Paired with the hydrate that owns each one — a field may only be dropped BECAUSE something
    // else restores it, so the pairing is the actual invariant.
    for (const [field, owner] of [
      ["components", "hydrateComponents"],
      ["blueprints", "store/index.ts blueprint list --full"],
      ["skills", "hydrateSkills"],
      ["skillGroups", "hydrateSkills"],
      ["personas", "hydratePersonas"],
      ["teams", "hydrateOrgs"],
    ]) {
      expect(field in snap, `${field} must stay out of persist — ${owner} restores it`).toBe(false);
    }
  });

  it("a fat bsc-owned library added to the store does NOT grow the persisted snapshot (#4086)", () => {
    // The generalization of the #3610 proof: the heavy libraries no longer ride along on every write.
    const before = JSON.stringify(persistedState(useAppStore.getState())).length;
    const fat = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, body: "y".repeat(4000) }));
    useAppStore.setState({ blueprints: fat(100) as never, skills: fat(30) as never, personas: fat(20) as never });
    expect(JSON.stringify(persistedState(useAppStore.getState())).length).toBe(before);
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
