// #4088 — the Glance triaged marker moved from app-state.json into projects.db.
//
// The marker gates the ENTIRE Glance network (`filterTriaged`, #2541): an untriaged project does not
// appear at all. Living only in the persisted zustand blob meant no `bsc` command could read or repair
// it, an app-state reset silently emptied the graph, and a missing node could only be diagnosed by
// reading a raw JSON blob — which is exactly what happened to `network-monitor` and `studio-code`.
import { describe, it, expect, vi, beforeEach } from "vitest";

const setDbTriaged = vi.fn();
vi.mock("@/features/planner/list/projectsDbBridge", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  setDbTriaged: (...a: unknown[]) => setDbTriaged(...a),
}));

import { useAppStore } from "@/store";
import { persistedState } from "@/store/persist";

beforeEach(() => {
  setDbTriaged.mockReset();
  useAppStore.setState({ triagedProjects: {} });
});

describe("the triaged marker is durable, not a persisted blob (#4088)", () => {
  it("is NOT in the persist allowlist — projects.db owns it now", () => {
    expect("triagedProjects" in persistedState(useAppStore.getState())).toBe(false);
  });

  it("writes through to projects.db when a project is triaged", () => {
    useAppStore.getState().markProjectTriaged("network-monitor");
    expect(setDbTriaged).toHaveBeenCalledWith("network-monitor");
    expect(useAppStore.getState().triagedProjects["network-monitor"]).toBeTypeOf("number");
  });

  it("keeps the FIRST timestamp — re-triaging never rewrites history", () => {
    useAppStore.setState({ triagedProjects: { alpha: 111 } });
    useAppStore.getState().markProjectTriaged("alpha");
    expect(useAppStore.getState().triagedProjects.alpha).toBe(111);
  });

  it("ignores an empty key rather than writing a junk row", () => {
    useAppStore.getState().markProjectTriaged("");
    expect(setDbTriaged).not.toHaveBeenCalled();
    expect(Object.keys(useAppStore.getState().triagedProjects)).toEqual([]);
  });

  it("hydrate UNIONS the db set in without dropping a marker set this session", () => {
    // The upgrade path: a marker that exists only in the pre-#4088 cache must survive hydration, or a
    // project the user already worked disappears from Glance the first time they launch.
    useAppStore.setState({ triagedProjects: { "set-this-session": 999 } });
    useAppStore.getState().hydrateTriaged({ "from-db": 111, "set-this-session": 222 });
    const out = useAppStore.getState().triagedProjects;
    expect(out["from-db"]).toBe(111);
    expect(out["set-this-session"]).toBe(999); // the in-memory marker wins, nothing is lost
  });
});
