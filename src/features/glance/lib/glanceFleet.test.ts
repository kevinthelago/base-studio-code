import { describe, it, expect } from "vitest";
import { buildFleetData, buildRealFleetData, nodeHasLiveSession } from "./glanceFleet";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Persona } from "@/features/personas";

describe("buildFleetData (glance drill)", () => {
  it("builds a deterministic sample fleet: director + reviewer + 2–4 workers, all edges wired", () => {
    const a = buildFleetData({ id: "proj-x", name: "X" });
    expect(a).toEqual(buildFleetData({ id: "proj-x", name: "X" })); // deterministic per project
    expect(a.sample).toBe(true);

    const ids = a.rawNodes.map((n) => n.id);
    expect(ids).toContain("director");
    expect(ids).toContain("reviewer");
    const workers = a.rawNodes.filter((n) => n.id.startsWith("worker-"));
    expect(workers.length).toBeGreaterThanOrEqual(2);
    expect(workers.length).toBeLessThanOrEqual(4);

    // each worker takes direction from the director (api) and is read by the reviewer (data)
    for (const w of workers) {
      expect(a.rawEdges).toContainEqual({ from: w.id, to: "director", kind: "api" });
      expect(a.rawEdges).toContainEqual({ from: "reviewer", to: w.id, kind: "data" });
    }
  });

  it("varies the worker count by project id", () => {
    const counts = new Set(
      ["a", "bb", "ccc", "dddd", "project-network", "ledger-svc"].map(
        (id) => buildFleetData({ id, name: id }).rawNodes.filter((n) => n.id.startsWith("worker-")).length,
      ),
    );
    expect(counts.size).toBeGreaterThan(1); // not all the same
  });
});

describe("buildRealFleetData (glance drill — real fleet)", () => {
  const personas: Persona[] = [
    { id: "p-worker", name: "Worker", blurb: "", role: "worker", startPrompt: "", skills: [] },
    { id: "p-reviewer", name: "Reviewer", blurb: "", role: "reviewer", startPrompt: "", skills: [] },
  ];
  const fleet = {
    recommended: 2, reasoning: "",
    streams: [
      { id: "api", name: "API", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-worker" },
      { id: "ui", name: "UI", repo: "r", owns: [], issues: [], dependsOn: ["api"], persona: "p-worker" },
      { id: "qa", name: "QA", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-reviewer" },
    ],
    director: { enabled: true },
    edges: [{ id: "e1", from: "api", to: "ui", kind: "handoff" as const, hardness: "blocking" as const, via: "direct" as const }],
  } as unknown as FleetPlan;

  it("maps streams→nodes (role via persona), a director hub, and coordination + dependsOn edges", () => {
    const d = buildRealFleetData(fleet, personas);
    expect(d.sample).toBe(false);
    const byId = Object.fromEntries(d.rawNodes.map((n) => [n.id, n]));
    expect(byId.api.role).toBe("service");   // worker → service (colour category)
    expect(byId.api.roleLabel).toBe("worker"); // real role carried for display
    expect(byId.qa.role).toBe("data");       // reviewer → data
    expect(byId.qa.roleLabel).toBe("reviewer");
    expect(byId.director.role).toBe("infra");// director hub added
    expect(byId.director.roleLabel).toBe("director");
    // director hub: each stream depends on the director
    expect(d.rawEdges).toContainEqual({ from: "api", to: "director", kind: "api" });
    // dependsOn: ui depends on api
    expect(d.rawEdges).toContainEqual({ from: "ui", to: "api", kind: "api" });
    // coordination edge producer→consumer (api→ui handoff) ⇒ consumer depends on producer (deduped w/ dependsOn)
    expect(d.rawEdges.filter((e) => e.from === "ui" && e.to === "api")).toHaveLength(1);
  });
});

describe("nodeHasLiveSession (#2534/#2542 — a fleet-tab cell morphs)", () => {
  // A launched build tab: the director + workers are all cells (paneIds), so all are openable.
  const live = new Set(["proj:director", "proj:foundation", "proj:pages-a"]);

  it("is live for a worker cell of the launched fleet tab", () => {
    expect(nodeHasLiveSession("proj:foundation", live)).toBe(true);
  });

  it("is live for the DIRECTOR cell — same durable tab-membership signal as workers (#2542)", () => {
    // The director isn't a stream (never in the roster) and sits idle between prompts, but it IS a
    // cell in the build tab, so it opens exactly like a worker.
    expect(nodeHasLiveSession("proj:director", live)).toBe(true);
  });

  it("is NOT live for a pane that isn't a cell of any launched tab", () => {
    expect(nodeHasLiveSession("proj:ghost", live)).toBe(false);
    expect(nodeHasLiveSession("proj:director", new Set())).toBe(false);
  });
});
