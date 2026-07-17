import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "@/store";
import { BUILTIN_ORGS } from "./lib/team";
import * as bridge from "./lib/orgBridge";

describe("org store slice (#2193)", () => {
  beforeEach(() => {
    useAppStore.setState({ teams: BUILTIN_ORGS });
    vi.restoreAllMocks();
  });

  it("hydrateOrgs keeps the seeded set when the bridge is unreachable", async () => {
    vi.spyOn(bridge, "loadOrgs").mockResolvedValueOnce(null);
    await useAppStore.getState().hydrateOrgs();
    expect(useAppStore.getState().teams).toEqual(BUILTIN_ORGS);
  });

  it("hydrateOrgs reconciles + re-seeds a dropped built-in, pushing it back", async () => {
    vi.spyOn(bridge, "loadOrgs").mockResolvedValueOnce([]); // store empty → every built-in re-seeds
    const push = vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateOrgs();
    expect(useAppStore.getState().teams.some((o) => o.id === "org-default-fleet" && o.builtin)).toBe(true);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ id: "org-default-fleet" }));
  });

  it("hydrateOrgs refreshes a STALE on-disk built-in to the packaged structure + pushes it back (#3330)", async () => {
    const base = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;
    // A built-in frozen on disk at an old version (renamed, emptied) — the stale-seed shape.
    const stale = { id: "org-default-fleet", name: "Old fleet", positions: [], relationships: [], builtin: true };
    vi.spyOn(bridge, "loadOrgs").mockResolvedValueOnce([stale]);
    const push = vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateOrgs();
    const fleet = useAppStore.getState().teams.find((o) => o.id === "org-default-fleet")!;
    expect(fleet.name).toBe(base.name);                       // rendered fresh, not "Old fleet"
    expect(fleet.positions).toEqual(base.positions);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ id: "org-default-fleet", name: base.name }));
  });

  it("hydrateOrgs does NOT re-push a built-in whose on-disk copy already matches the packaged def (#3330)", async () => {
    const fresh = BUILTIN_ORGS.map((o) => ({ ...o })); // on-disk == packaged for every built-in
    vi.spyOn(bridge, "loadOrgs").mockResolvedValueOnce(fresh);
    const push = vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateOrgs();
    expect(push).not.toHaveBeenCalled(); // no drift → no needless write storm each boot
  });

  it("addOrg appends an editable org and returns its id", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const before = useAppStore.getState().teams.length;
    const id = useAppStore.getState().addOrg();
    const teams = useAppStore.getState().teams;
    expect(teams.length).toBe(before + 1);
    expect(teams.find((o) => o.id === id)!.builtin).toBeUndefined();
  });

  it("cloneOrg copies a built-in into a new editable org", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().cloneOrg("org-default-fleet");
    const clone = useAppStore.getState().teams.find((o) => o.id === id)!;
    expect(clone.builtin).toBe(false);
    expect(clone.positions.length).toBeGreaterThan(0); // deep contents carried
    expect(clone.name).toMatch(/copy/i);
  });

  it("removeOrg deletes a user org but NOT a built-in", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    vi.spyOn(bridge, "dropOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().addOrg();
    useAppStore.getState().removeOrg(id);
    expect(useAppStore.getState().teams.some((o) => o.id === id)).toBe(false);
    const n = useAppStore.getState().teams.length;
    useAppStore.getState().removeOrg("org-default-fleet");
    expect(useAppStore.getState().teams.length).toBe(n); // built-in remove is a no-op
  });

  it("removePosition drops the node AND every edge touching it", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().cloneOrg("org-default-fleet");
    useAppStore.getState().removePosition(id, "engineer");
    const org = useAppStore.getState().teams.find((o) => o.id === id)!;
    expect(org.positions.some((p) => p.nodeId === "engineer")).toBe(false);
    expect(org.relationships.some((r) => r.from === "engineer" || r.to === "engineer")).toBe(false);
  });

  it("addRelationship + removeRelationship mutate the edge set", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().addOrg();
    useAppStore.getState().addPosition(id, { nodeId: "a", kind: "agent" });
    useAppStore.getState().addPosition(id, { nodeId: "b", kind: "agent" });
    useAppStore.getState().addRelationship(id, { id: "e1", archetype: "peers", from: "a", to: "b" });
    expect(useAppStore.getState().teams.find((o) => o.id === id)!.relationships).toHaveLength(1);
    useAppStore.getState().removeRelationship(id, "e1");
    expect(useAppStore.getState().teams.find((o) => o.id === id)!.relationships).toHaveLength(0);
  });

  it("updateRelationship changes an edge's archetype (#2199 inspector)", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().cloneOrg("org-default-fleet");
    useAppStore.getState().updateRelationship(id, "r-mgr-eng", { archetype: "oversees" });
    const rel = useAppStore.getState().teams.find((o) => o.id === id)!.relationships.find((r) => r.id === "r-mgr-eng")!;
    expect(rel.archetype).toBe("oversees");
    expect(rel.id).toBe("r-mgr-eng"); // id is preserved
  });

  it("updatePosition repoints a position's persona + moves it (#2199 drag/picker)", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().cloneOrg("org-default-fleet");
    useAppStore.getState().updatePosition(id, "engineer", { personaId: "persona-reviewer", x: 12, y: 34 });
    const pos = useAppStore.getState().teams.find((o) => o.id === id)!.positions.find((p) => p.nodeId === "engineer")!;
    expect(pos.personaId).toBe("persona-reviewer");
    expect(pos).toMatchObject({ x: 12, y: 34, nodeId: "engineer" });
  });

  it("setTeamsZoom remembers a per-org zoom (#2199 view state)", () => {
    useAppStore.getState().setTeamsZoom("org-default-fleet", 0.85);
    expect(useAppStore.getState().teamsZoom["org-default-fleet"]).toBe(0.85);
  });
});
