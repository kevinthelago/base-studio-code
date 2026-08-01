// The WHOLE chain, end to end (#4118) — real fleet shape → progress → buildGraph → the node.
//
// Every layer was verified in isolation and the bars still did not appear, twice. That is the signature
// of a JOIN that fails silently: each half is correct and the keys do not meet. This asserts the join.
import { describe, it, expect } from "vitest";
import { fleetPlanProgress } from "./lib/fleetPlanProgress";
import { withStreamProgress } from "./lib/streamProgress";
import { buildRealFleetData } from "./lib/glanceFleet";
import { buildGraph } from "./lib/glanceGraph";
import { fleetToOrg } from "./lib/glanceFleet";

// The live shape: streams carrying GitHub refs, exactly as `bsc plan fleet get` returns them.
const fleet = {
  streams: [
    { id: "cli-platform", name: "CLI", repo: "kev/app", owns: [], issues: ["#3898", "#3979"], dependsOn: [] },
    { id: "console", name: "Console", repo: "kev/app", owns: [], issues: ["#3871"], dependsOn: [] },
    { id: "standing", name: "Standing", repo: "kev/app", owns: [], issues: [], dependsOn: [] },
  ],
  director: { enabled: true },
} as unknown as Parameters<typeof fleetToOrg>[0];

describe("progress reaches the rendered node (#4118)", () => {
  it("a fleet node's id IS its stream id — the join the whole feature rests on", () => {
    // If these ever diverge, every lookup misses and the bars vanish with nothing failing.
    const org = fleetToOrg(fleet);
    const ids = org.positions.map((p) => p.nodeId);
    expect(ids).toContain("cli-platform");
    expect(ids).toContain("console");
  });

  it("carries done/total from the stream refs all the way onto the built graph node", () => {
    const byStream = fleetPlanProgress(fleet.streams, new Set(["3898", "3871"]));
    const raw = withStreamProgress(buildRealFleetData(fleet, []).rawNodes, byStream);
    const graph = buildGraph(raw, []);

    const cli = graph.nodes.find((n) => n.id === "cli-platform");
    expect(cli?.progress).toEqual({ done: 1, total: 2 });
    const console_ = graph.nodes.find((n) => n.id === "console");
    expect(console_?.progress).toEqual({ done: 1, total: 1 });
  });

  it("a stream owning nothing reaches the node with total 0, so it draws no bar", () => {
    const byStream = fleetPlanProgress(fleet.streams, new Set());
    const raw = withStreamProgress(buildRealFleetData(fleet, []).rawNodes, byStream);
    const graph = buildGraph(raw, []);
    expect(graph.nodes.find((n) => n.id === "standing")?.progress).toEqual({ done: 0, total: 0 });
  });

  it("buildGraph does not DROP progress while mapping raw nodes to graph nodes", () => {
    // The spread at the node construction is load-bearing; an explicit field list would silently lose it.
    const raw = withStreamProgress(
      buildRealFleetData(fleet, []).rawNodes,
      fleetPlanProgress(fleet.streams, new Set(["3898"])),
    );
    expect(raw.some((n) => n.progress)).toBe(true);
    expect(buildGraph(raw, []).nodes.some((n) => n.progress)).toBe(true);
  });
});
