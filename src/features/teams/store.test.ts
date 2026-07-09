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
    useAppStore.getState().removePosition(id, "worker-a");
    const org = useAppStore.getState().teams.find((o) => o.id === id)!;
    expect(org.positions.some((p) => p.nodeId === "worker-a")).toBe(false);
    expect(org.relationships.some((r) => r.from === "worker-a" || r.to === "worker-a")).toBe(false);
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
    useAppStore.getState().updateRelationship(id, "r-mgr-a", { archetype: "oversees" });
    const rel = useAppStore.getState().teams.find((o) => o.id === id)!.relationships.find((r) => r.id === "r-mgr-a")!;
    expect(rel.archetype).toBe("oversees");
    expect(rel.id).toBe("r-mgr-a"); // id is preserved
  });

  it("updatePosition repoints a position's persona + moves it (#2199 drag/picker)", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().cloneOrg("org-default-fleet");
    useAppStore.getState().updatePosition(id, "worker-a", { personaId: "persona-reviewer", x: 12, y: 34 });
    const pos = useAppStore.getState().teams.find((o) => o.id === id)!.positions.find((p) => p.nodeId === "worker-a")!;
    expect(pos.personaId).toBe("persona-reviewer");
    expect(pos).toMatchObject({ x: 12, y: 34, nodeId: "worker-a" });
  });

  it("setTeamsZoom remembers a per-org zoom (#2199 view state)", () => {
    useAppStore.getState().setTeamsZoom("org-default-fleet", 0.85);
    expect(useAppStore.getState().teamsZoom["org-default-fleet"]).toBe(0.85);
  });
});
