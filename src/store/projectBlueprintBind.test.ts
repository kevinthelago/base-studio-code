// Per-project blueprint BIND + adjacent plan-slice actions (#647/#2277/#673/#1395).
//
// Blueprints are locked at creation (no switching, #3785) — `setProjectBlueprintId` is the creation
// bind. These pin the KEPT plan-slice behaviour that used to live alongside the now-removed
// blueprint-switch tests: the bind records the id, a kit-bearing bind files the #2277 consumer-index
// edge, the confirm/unconfirm round-trip drives the gate, and `seedDiscoveryOnlyStages` seeds a fresh
// project once.
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";

describe("project blueprint bind + plan-slice actions", () => {
  beforeEach(() => {
    useAppStore.setState({
      projectBlueprintId: {},
      planStageConfig: {},
      planStages: { p: { goal: "# Goal" } },
      planConfirmedStages: { p: ["goal"] },
      kitUsage: [], // #2277: isolate the consumer-index edges the bind auto-records
      planClassification: {},
    });
  });

  it("setProjectBlueprintId records the id", () => {
    useAppStore.getState().setProjectBlueprintId("p", "api");
    expect(useAppStore.getState().projectBlueprintId["p"]).toBe("api");
  });

  it("auto-records the blueprint's kit as a consumer-index edge on bind (#2277)", () => {
    // `default` is a kit-bearing greenfield blueprint (kit: react-ui) — binding it makes the project a
    // consumer, so the kit_usage edge is filed automatically (the index self-fills at planning).
    useAppStore.getState().setProjectBlueprintId("p", "default");
    expect(useAppStore.getState().kitUsage).toContainEqual({ projectKey: "p", kitId: "react-ui" });
  });

  it("records nothing for a kit-less blueprint, and stays idempotent across re-binds (#2277)", () => {
    // An unknown / kit-less blueprint id resolves to no kit → no edge filed.
    useAppStore.getState().setProjectBlueprintId("q", "no-such-blueprint");
    expect(useAppStore.getState().kitUsage.some((u) => u.projectKey === "q")).toBe(false);
    // Re-binding the same kit-bearing blueprint keeps exactly one edge (idempotent by projectKey+kitId).
    useAppStore.getState().setProjectBlueprintId("r", "default");
    useAppStore.getState().setProjectBlueprintId("r", "default");
    expect(useAppStore.getState().kitUsage.filter((u) => u.projectKey === "r")).toEqual([
      { projectKey: "r", kitId: "react-ui" },
    ]);
  });

  it("confirmPlanStage / unconfirmPlanStage round-trip (drives the gate, #673)", () => {
    useAppStore.setState({ planConfirmedStages: {} });
    const s = useAppStore.getState();
    s.confirmPlanStage("p", "goal");
    s.confirmPlanStage("p", "goal"); // idempotent
    s.confirmPlanStage("p", "scope");
    expect(useAppStore.getState().planConfirmedStages["p"]).toEqual(["goal", "scope"]);
    s.unconfirmPlanStage("p", "goal");
    expect(useAppStore.getState().planConfirmedStages["p"]).toEqual(["scope"]);
  });

  it("seedDiscoveryOnlyStages seeds Discovery-only for a fresh project, and is a no-op once set (#1395)", () => {
    useAppStore.setState({ planStageConfig: {} });
    useAppStore.getState().seedDiscoveryOnlyStages("fresh");
    const c = useAppStore.getState().planStageConfig["fresh"];
    expect(c.enabled.discovery).toBe(true);
    expect(c.enabled.features).toBe(false); // every non-context stage starts off (additive)
    // idempotent: re-seeding never clobbers an existing config (a blueprint-seeded or in-progress plan)
    useAppStore.getState().setStageEnabled("fresh", "features", true);
    useAppStore.getState().seedDiscoveryOnlyStages("fresh");
    expect(useAppStore.getState().planStageConfig["fresh"].enabled.features).toBe(true);
  });

  it("setPlanClassification records the project's classification (#3783/#3784)", () => {
    // Unset → the store map has no entry; FocusedBodies defaults uiMode to "custom" and the
    // visibility signals default false (source/mcp/skills/automations hidden).
    expect(useAppStore.getState().planClassification["p"]).toBeUndefined();
    useAppStore.getState().setPlanClassification("p", { uiMode: "external", needsSource: true });
    expect(useAppStore.getState().planClassification["p"]).toEqual({ uiMode: "external", needsSource: true });
    useAppStore.getState().setPlanClassification("p", { uiMode: "custom" });
    expect(useAppStore.getState().planClassification["p"]).toEqual({ uiMode: "custom" });
  });
});
