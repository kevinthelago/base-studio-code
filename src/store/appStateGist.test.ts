import { describe, it, expect, beforeEach } from "vitest";
import { appStateToManifest, appStateFromManifest, APP_STATE_KIND } from "./appStateGist";
import { wrapExtension } from "@/features/planner/lib/gist/manifest";
import { useAppStore } from ".";

describe("app-state manifest envelope (#2272)", () => {
  it("wraps a snapshot as an 'app-state' manifest", () => {
    const m = appStateToManifest({ personas: [{ id: "p" }] as never }, "My demo");
    expect(m.kind).toBe(APP_STATE_KIND);
    expect(m.name).toBe("My demo");
    expect(m.payload).toEqual({ personas: [{ id: "p" }] });
  });

  it("reconstructs + SANITIZES a snapshot from an app-state manifest", () => {
    // A hostile payload smuggles a token + a bogus key alongside a real one.
    const m = wrapExtension(APP_STATE_KIND, "app-state", "Demo", "1.0.0", {
      githubToken: "ghp_leak", notAKey: 1, blueprints: [{ id: "bp", name: "BP" }],
    });
    const res = appStateFromManifest(m);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot).toEqual({ blueprints: [{ id: "bp", name: "BP" }] });
      expect("githubToken" in res.snapshot).toBe(false);
    }
  });

  it("rejects a manifest of the wrong kind", () => {
    const res = appStateFromManifest(wrapExtension("blueprint", "bp", "n", "1", {}));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/expected an app-state/);
  });
});

describe("demo load/clear store actions (#2272)", () => {
  beforeEach(() => useAppStore.setState({
    demoActive: false, demoBackup: null,
    personas: [{ id: "real" }] as never, blueprints: [] as never,
  }));

  it("loadDemoState MERGES the demo onto existing state AND backs up the pre-demo state (#2288)", () => {
    useAppStore.getState().loadDemoState({ personas: [{ id: "demo-a" }, { id: "demo-b" }] as never });
    const s = useAppStore.getState();
    expect(s.demoActive).toBe(true);
    // The built-in/real persona is PRESERVED (merge, not replace); demo personas appended.
    expect(s.personas.map((p) => p.id)).toEqual(["real", "demo-a", "demo-b"]);
    expect(s.demoBackup?.personas?.map((p: { id: string }) => p.id)).toEqual(["real"]); // real stashed
  });

  it("clearDemoState restores exactly the pre-demo state (drops the demo's additions)", () => {
    const store = useAppStore.getState();
    store.loadDemoState({ personas: [{ id: "demo" }] as never });
    expect(useAppStore.getState().personas.map((p) => p.id)).toEqual(["real", "demo"]); // merged
    useAppStore.getState().clearDemoState();
    const s = useAppStore.getState();
    expect(s.demoActive).toBe(false);
    expect(s.demoBackup).toBeNull();
    expect(s.personas.map((p) => p.id)).toEqual(["real"]); // restored — demo addition removed
  });

  it("a second load keeps the ORIGINAL backup (doesn't stash the demo as the backup)", () => {
    const store = useAppStore.getState();
    store.loadDemoState({ personas: [{ id: "demo1" }] as never });
    useAppStore.getState().loadDemoState({ personas: [{ id: "demo2" }] as never });
    // Backup must still be the real pre-demo state, not demo1.
    expect(useAppStore.getState().demoBackup?.personas?.map((p: { id: string }) => p.id)).toEqual(["real"]);
    useAppStore.getState().clearDemoState();
    expect(useAppStore.getState().personas.map((p) => p.id)).toEqual(["real"]);
  });
});
