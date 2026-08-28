// Launching a project records its TRIAGED marker DURABLY (#the-triaged-marker-is-never-written-through).
//
// Glance draws only triaged projects (`filterTriaged`, #2541). Both launch paths stamped the marker
// inline in their zustand `set` — and `triagedProjects` is deliberately NOT persisted, because it
// hydrates from projects.db (#4088). So the stamp lived for the session and every boot read an empty
// map from a database nothing ever wrote: the graph was blank after every restart, hiding projects
// that had in fact been worked. Measured on the real store: `bsc project db triaged` returned 0
// across 27 projects.
//
// `markProjectTriaged` did exactly the right thing and had NO production caller; `setDbTriaged` was
// not even imported in the slice that launches fleets. The assertion that matters is therefore about
// the WRITE-THROUGH, not about the in-memory map — an in-memory-only stamp is what the bug was.
import { describe, it, expect, vi, beforeEach } from "vitest";

const dbWrites: string[] = [];
vi.mock("@/features/planner/list/projectsDbBridge", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/planner/list/projectsDbBridge")>();
  return { ...real, setDbTriaged: async (key: string) => { dbWrites.push(key); } };
});

const { useAppStore } = await import("@/store");

beforeEach(() => {
  dbWrites.length = 0;
  useAppStore.setState({ tabs: [], triagedProjects: {}, automations: [] });
});

describe("a launched project is recorded as triaged in the durable store", () => {
  it("writes the marker through when a fleet (or a lone director) launches", () => {
    // The architect's handoff takes this path: `bsc fleet director new` builds a director-only
    // FleetPlan and hands it to `fleetStartProject`, so this is what makes its project appear.
    useAppStore.getState().fleetStartProject(
      "Pain Point Finder",
      { recommended: 0, reasoning: "director only", streams: [], director: { enabled: true } },
      "pain-point-finder",
    );
    expect(dbWrites, "the marker must reach projects.db, not just the store").toContain("pain-point-finder");
    expect(useAppStore.getState().triagedProjects["pain-point-finder"]).toBeTruthy();
  });

  it("writes it through when triage launches", () => {
    useAppStore.getState().triageStartProject("Pain Point Finder", ["repo-a"], "pain-point-finder");
    expect(dbWrites).toContain("pain-point-finder");
  });

  it("records NOTHING when triage no-ops for want of a repo", () => {
    // The updater bails on an empty repo list, so no tab is created and nothing was worked — marking
    // it would put a project on the graph that never launched.
    useAppStore.getState().triageStartProject("Pain Point Finder", [], "pain-point-finder");
    expect(dbWrites).toEqual([]);
  });
});
