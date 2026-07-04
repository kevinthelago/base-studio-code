import { describe, it, expect, beforeEach } from "vitest";
import { demoSnapshot, DEMO_GIST_URL } from "./demoSnapshot";
import { DEMOABLE_KEYS, pickDemoable } from "./appState";
import { appStateToManifest, appStateFromManifest } from "./appStateGist";
import { useAppStore } from ".";

describe("curated demo snapshot (#2282)", () => {
  it("only contains DEMOABLE_KEYS — passes pickDemoable unchanged (the security allowlist)", () => {
    const snap = demoSnapshot();
    // Every key is on the allowlist…
    for (const k of Object.keys(snap)) expect(DEMOABLE_KEYS).toContain(k);
    // …and filtering to the allowlist is a no-op (nothing secret/machine rides along).
    expect(pickDemoable(snap)).toEqual(snap);
  });

  it("survives the manifest envelope round-trip (publish → load) byte-for-byte", () => {
    const snap = demoSnapshot();
    const parsed = appStateFromManifest(appStateToManifest(snap, "Demo app-state"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.snapshot).toEqual(snap);
  });

  it("is a populated world (projects, fleets, and every library)", () => {
    const snap = demoSnapshot();
    expect(Object.keys(snap.localDraftProjects ?? {})).toHaveLength(14); // the SAMPLE_GRAPH spine
    expect((snap.projectLinks ?? []).length).toBeGreaterThan(10);
    expect(Object.keys(snap.planFleet ?? {}).length).toBeGreaterThan(0);
    expect((snap.personas ?? []).length).toBeGreaterThan(0);
    expect((snap.orgs ?? []).length).toBeGreaterThan(0);
    expect((snap.skills ?? []).length).toBeGreaterThan(0);
    expect((snap.blueprints ?? []).length).toBeGreaterThan(0);
    expect((snap.automations ?? []).length).toBeGreaterThan(0);
  });

  it("is internally consistent — every cross-reference resolves to something in this world", () => {
    const snap = demoSnapshot();
    const projectIds = new Set(Object.keys(snap.localDraftProjects ?? {}));
    const skillIds = new Set((snap.skills ?? []).map((s) => s.id));
    const personaIds = new Set((snap.personas ?? []).map((p) => p.id));

    // projectLinks connect projects that exist.
    for (const link of snap.projectLinks ?? []) {
      expect(projectIds.has(link.from)).toBe(true);
      expect(projectIds.has(link.to)).toBe(true);
    }
    // fleets are keyed by real projects; every worker stream launches as a real persona.
    for (const [key, fleet] of Object.entries(snap.planFleet ?? {})) {
      expect(projectIds.has(key)).toBe(true);
      for (const stream of fleet.streams) {
        if (stream.persona) expect(personaIds.has(stream.persona)).toBe(true);
      }
    }
    // personas reference real skills.
    for (const p of snap.personas ?? []) for (const s of p.skills) expect(skillIds.has(s)).toBe(true);
    // skill groups reference real skills.
    for (const g of snap.skillGroups ?? []) for (const s of g.skillIds) expect(skillIds.has(s)).toBe(true);
    // org agent positions reference real personas.
    for (const org of snap.orgs ?? []) {
      for (const pos of org.positions) {
        if (pos.kind === "agent") expect(personaIds.has(pos.personaId ?? "")).toBe(true);
      }
    }
    // the demo blueprint attaches only real skills; the active blueprint is one we ship in the snapshot.
    const bpIds = new Set((snap.blueprints ?? []).map((b) => b.id));
    for (const b of snap.blueprints ?? []) for (const s of b.skills ?? []) expect(skillIds.has(s)).toBe(true);
    expect(bpIds.has(snap.activeBlueprintId ?? "")).toBe(true);
    // every project is seeded from a blueprint we ship.
    for (const bpId of Object.values(snap.projectBlueprintId ?? {})) expect(bpIds.has(bpId)).toBe(true);
  });

  it("the maintainer gist URL is intentionally empty (local snapshot is the functional path)", () => {
    expect(DEMO_GIST_URL).toBe("");
  });
});

describe("demo snapshot round-trips through loadDemoState (#2282)", () => {
  beforeEach(() => useAppStore.setState({ demoActive: false, demoBackup: null }));

  it("loads the demo (MERGING onto built-ins) and clears back to the pre-demo state", () => {
    const before = useAppStore.getState();
    const builtinPersonas = before.personas.length;
    const builtinBlueprints = before.blueprints.length;

    useAppStore.getState().loadDemoState(demoSnapshot());
    const s = useAppStore.getState();
    expect(s.demoActive).toBe(true);
    // Projects + links populated.
    expect(Object.keys(s.localDraftProjects)).toHaveLength(14);
    expect(s.projectLinks.length).toBeGreaterThan(10);
    // Libraries AUGMENTED, not replaced (#2288): built-ins preserved + demo items added.
    expect(s.personas.length).toBeGreaterThan(builtinPersonas);
    expect(s.blueprints.length).toBeGreaterThan(builtinBlueprints);
    expect(s.personas.some((p) => p.id === "demo-payments-eng")).toBe(true);
    expect(s.blueprints.some((b) => b.id === "demo-microservices-platform")).toBe(true);
    // The demo fleet resolves against a demo project.
    expect(s.planFleet["billing-svc"]?.streams.length).toBeGreaterThan(0);

    useAppStore.getState().clearDemoState();
    const after = useAppStore.getState();
    expect(after.demoActive).toBe(false);
    expect(Object.keys(after.localDraftProjects)).toHaveLength(Object.keys(before.localDraftProjects).length);
    expect(after.personas.length).toBe(builtinPersonas);
    expect(after.blueprints.length).toBe(builtinBlueprints);
  });
});
