import { describe, it, expect } from "vitest";
import { openPaneIds, reconcileSessions, type DiscoveredSession, type ReconcileTab } from "./sessionRecovery";

const sess = (paneId: string, status: string, extra: Partial<DiscoveredSession> = {}): DiscoveredSession => ({
  paneId, sources: ["ledger"], status, ...extra,
});

describe("openPaneIds (#1266)", () => {
  it("uses minted paneIds for fleet/triage tabs", () => {
    const tab: ReconcileTab = { id: "b", kind: "build", paneIds: ["proj:director", "proj:auth"], layout: "2×1" };
    expect(openPaneIds([tab])).toEqual(new Set(["proj:director", "proj:auth"]));
  });

  it("derives man: ids per cell for a manual tab from its layout", () => {
    const tab: ReconcileTab = { id: "scratch", layout: "2×1" }; // no kind, no paneIds ⇒ manual
    expect(openPaneIds([tab])).toEqual(new Set(["man:scratch:p0", "man:scratch:p1"]));
  });

  it("falls back to positional ids for an id-less legacy tab", () => {
    expect(openPaneIds([{ layout: "1×1" }])).toEqual(new Set(["t0p0"]));
  });

  it("indexes tabs by position (man: ids stay per-tab, positional ids track the index)", () => {
    const tabs: ReconcileTab[] = [
      { id: "b", kind: "build", paneIds: ["proj:director"] },
      { layout: "1×1" }, // legacy at index 1
    ];
    expect(openPaneIds(tabs)).toEqual(new Set(["proj:director", "t1p0"]));
  });
});

describe("reconcileSessions (#1266)", () => {
  it("keeps only sessions not represented by an open pane, enriched with kind + reapOnly", () => {
    const tabs: ReconcileTab[] = [{ id: "b", kind: "build", paneIds: ["proj:director", "proj:auth"] }];
    const discovered = [
      sess("proj:director", "running"),                 // OPEN → dropped
      sess("proj:auth", "dormant"),                     // OPEN → dropped
      sess("proj:api", "planned", { repo: "own/api" }), // not open → kept (worker)
      sess("other:owner/web:triage", "running"),        // not open → kept (triage)
      sess("man:gone:p0", "running"),                   // not open → kept (manual, reap-only)
    ];

    const out = reconcileSessions(discovered, tabs);
    expect(out.map((s) => s.paneId)).toEqual(["proj:api", "other:owner/web:triage", "man:gone:p0"]);

    const byId = Object.fromEntries(out.map((s) => [s.paneId, s]));
    expect(byId["proj:api"].kind).toBe("worker");
    expect(byId["proj:api"].reapOnly).toBe(false);
    expect(byId["other:owner/web:triage"].kind).toBe("triage");
    expect(byId["man:gone:p0"].kind).toBe("manual");
    expect(byId["man:gone:p0"].reapOnly).toBe(true); // manual scratch shells are never restored
  });

  it("returns everything when no tabs are open", () => {
    const discovered = [sess("proj:director", "dormant"), sess("proj:auth", "dormant")];
    expect(reconcileSessions(discovered, []).map((s) => s.paneId)).toEqual(["proj:director", "proj:auth"]);
  });

  it("marks an unparseable id as unknown (not reap-only)", () => {
    const out = reconcileSessions([sess("garbage", "running")], []);
    expect(out[0].kind).toBe("unknown");
    expect(out[0].reapOnly).toBe(false);
  });

  it("flags an orphaned (deleted-project) shell reap-only, but not a restorable one (#1279)", () => {
    const out = reconcileSessions(
      [sess("gone:auth", "orphaned"), sess("proj:auth", "dormant")],
      [],
    );
    const byId = Object.fromEntries(out.map((s) => [s.paneId, s]));
    // The deleted project's live shell is reaped, never restored — nothing to rehydrate.
    expect(byId["gone:auth"].reapOnly).toBe(true);
    // A genuinely restorable worker is unaffected.
    expect(byId["proj:auth"].reapOnly).toBe(false);
  });
});
