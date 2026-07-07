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

describe("nodeHasLiveSession (#2534/#2539 — every terminal node morphs)", () => {
  it("is live when the pane is in the launched roster (workers)", () => {
    const roster = { "proj:api": { id: "api" } };
    expect(nodeHasLiveSession("proj:api", roster, {})).toBe(true);
  });

  it("is live for a running pane status", () => {
    expect(nodeHasLiveSession("proj:director", {}, { "proj:director": "run" })).toBe(true);
    expect(nodeHasLiveSession("proj:director", {}, { "proj:director": "on" })).toBe(true);
  });

  it("is live for a RESTING director — claude active but status idle (#2539)", () => {
    // The director isn't in the roster and sits at "idle" between prompts; a live claude session
    // (paneClaudeActive) is what keeps it morphable exactly when the user clicks it.
    expect(nodeHasLiveSession("proj:director", {}, { "proj:director": "idle" }, { "proj:director": true })).toBe(true);
    // claudeActive alone (no status yet — launch race) is enough.
    expect(nodeHasLiveSession("proj:director", {}, {}, { "proj:director": true })).toBe(true);
  });

  it("is NOT live with no roster, no claude session, and an idle/absent status", () => {
    expect(nodeHasLiveSession("proj:director", {}, { "proj:director": "idle" })).toBe(false);
    expect(nodeHasLiveSession("proj:director", {}, { "proj:director": "idle" }, { "proj:director": false })).toBe(false);
    expect(nodeHasLiveSession("proj:ghost", {}, {})).toBe(false);
  });
});
