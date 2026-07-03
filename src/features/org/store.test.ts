import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "@/store";
import { BUILTIN_ORGS } from "./lib/org";
import * as bridge from "./lib/orgBridge";

describe("org store slice (#2193)", () => {
  beforeEach(() => {
    useAppStore.setState({ orgs: BUILTIN_ORGS });
    vi.restoreAllMocks();
  });

  it("hydrateOrgs keeps the seeded set when the bridge is unreachable", async () => {
    vi.spyOn(bridge, "loadOrgs").mockResolvedValueOnce(null);
    await useAppStore.getState().hydrateOrgs();
    expect(useAppStore.getState().orgs).toEqual(BUILTIN_ORGS);
  });

  it("hydrateOrgs reconciles + re-seeds a dropped built-in, pushing it back", async () => {
    vi.spyOn(bridge, "loadOrgs").mockResolvedValueOnce([]); // store empty → every built-in re-seeds
    const push = vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    await useAppStore.getState().hydrateOrgs();
    expect(useAppStore.getState().orgs.some((o) => o.id === "org-default-fleet" && o.builtin)).toBe(true);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ id: "org-default-fleet" }));
  });

  it("addOrg appends an editable org and returns its id", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const before = useAppStore.getState().orgs.length;
    const id = useAppStore.getState().addOrg();
    const orgs = useAppStore.getState().orgs;
    expect(orgs.length).toBe(before + 1);
    expect(orgs.find((o) => o.id === id)!.builtin).toBeUndefined();
  });

  it("cloneOrg copies a built-in into a new editable org", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().cloneOrg("org-default-fleet");
    const clone = useAppStore.getState().orgs.find((o) => o.id === id)!;
    expect(clone.builtin).toBe(false);
    expect(clone.positions.length).toBeGreaterThan(0); // deep contents carried
    expect(clone.name).toMatch(/copy/i);
  });

  it("removeOrg deletes a user org but NOT a built-in", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    vi.spyOn(bridge, "dropOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().addOrg();
    useAppStore.getState().removeOrg(id);
    expect(useAppStore.getState().orgs.some((o) => o.id === id)).toBe(false);
    const n = useAppStore.getState().orgs.length;
    useAppStore.getState().removeOrg("org-default-fleet");
    expect(useAppStore.getState().orgs.length).toBe(n); // built-in remove is a no-op
  });

  it("removePosition drops the node AND every edge touching it", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().cloneOrg("org-default-fleet");
    useAppStore.getState().removePosition(id, "worker-a");
    const org = useAppStore.getState().orgs.find((o) => o.id === id)!;
    expect(org.positions.some((p) => p.nodeId === "worker-a")).toBe(false);
    expect(org.relationships.some((r) => r.from === "worker-a" || r.to === "worker-a")).toBe(false);
  });

  it("addRelationship + removeRelationship mutate the edge set", () => {
    vi.spyOn(bridge, "pushOrg").mockResolvedValue(undefined);
    const id = useAppStore.getState().addOrg();
    useAppStore.getState().addPosition(id, { nodeId: "a", kind: "agent" });
    useAppStore.getState().addPosition(id, { nodeId: "b", kind: "agent" });
    useAppStore.getState().addRelationship(id, { id: "e1", archetype: "peers", from: "a", to: "b" });
    expect(useAppStore.getState().orgs.find((o) => o.id === id)!.relationships).toHaveLength(1);
    useAppStore.getState().removeRelationship(id, "e1");
    expect(useAppStore.getState().orgs.find((o) => o.id === id)!.relationships).toHaveLength(0);
  });
});
