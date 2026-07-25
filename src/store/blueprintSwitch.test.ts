import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";

describe("blueprint-per-project + reset (#647)", () => {
  beforeEach(() => {
    useAppStore.setState({
      projectBlueprintId: {},
      uiScreens: { p: ["Home"] },
      uiApproved: { p: ["Home"] },
      planStageConfig: {},
      stagePreview: {},
      stageRuns: {},
      // section state + fleet/automations also drive completion — must reset too (#664)
      planStages: { p: { goal: "# Goal" } },
      planConfirmedStages: { p: ["goal"] },
      planAutomations: { p: [] },
      projectLocalRepos: { p: ["o/r"] },
      kitUsage: [], // #2277: isolate the consumer-index edges the bind auto-records
    });
  });

  it("setProjectBlueprintId records the id", () => {
    useAppStore.getState().setProjectBlueprintId("p", "api");
    expect(useAppStore.getState().projectBlueprintId["p"]).toBe("api");
  });

  it("applyBlueprintToProject re-seeds the config, records the blueprint, and clears progress (switch)", () => {
    useAppStore.getState().setProjectBlueprintId("p", "default"); // greenfield origin
    useAppStore.getState().applyBlueprintToProject("p", "complete"); // → another blueprint (allowed)
    const s = useAppStore.getState();
    expect(s.projectBlueprintId["p"]).toBe("complete");
    expect(s.planStageConfig["p"]).toBeTruthy();
    expect(s.planStageConfig["p"].order.length).toBeGreaterThan(0);
    // progress keyed to the old arc is wiped
    expect(s.uiScreens["p"]).toBeUndefined();
    expect(s.uiApproved["p"]).toBeUndefined();
    // section state + confirmations + automations also cleared so nothing reads complete (#664)
    expect(s.planStages["p"]).toBeUndefined();
    expect(s.planConfirmedStages["p"]).toBeUndefined();
    expect(s.planAutomations["p"]).toBeUndefined();
    expect(s.projectLocalRepos["p"]).toBeUndefined(); // repos unlinked (#664)
  });

  it("auto-records the blueprint's kit as a consumer-index edge on bind (#2277)", () => {
    // `default` is a kit-bearing greenfield blueprint (kit: react-ui) — binding it makes the project a
    // consumer, so the kit_usage edge is filed automatically (the index self-fills at planning).
    useAppStore.getState().setProjectBlueprintId("p", "default");
    expect(useAppStore.getState().kitUsage).toContainEqual({ projectKey: "p", kitId: "react-ui" });
  });

  it("records nothing for a kit-less blueprint, and stays idempotent across a switch (#2277)", () => {
    // A transform blueprint (feature-add) declares no kit → no edge.
    useAppStore.getState().setProjectBlueprintId("q", "feature-add");
    expect(useAppStore.getState().kitUsage.some((u) => u.projectKey === "q")).toBe(false);
    // A greenfield project switched between two react-ui blueprints keeps exactly one edge (idempotent).
    useAppStore.getState().setProjectBlueprintId("r", "default");
    useAppStore.getState().applyBlueprintToProject("r", "complete");
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

  it("is a no-op for an unknown blueprint", () => {
    useAppStore.getState().applyBlueprintToProject("p", "nope");
    const s = useAppStore.getState();
    expect(s.projectBlueprintId["p"]).toBeUndefined();
    expect(s.uiScreens["p"]).toBeTruthy(); // untouched
  });

  it("now allows any project blueprint → any other, re-seeding on switch (#1281)", () => {
    // any → any is allowed now (was refused under the #923 one-way rule)
    useAppStore.getState().setProjectBlueprintId("p", "default");
    useAppStore.getState().applyBlueprintToProject("p", "complete");
    expect(useAppStore.getState().projectBlueprintId["p"]).toBe("complete"); // switched
    expect(useAppStore.getState().uiScreens["p"]).toBeUndefined();           // progress wiped on switch
    // and back again — the soft-lock is gone (#1281)
    useAppStore.getState().setProjectBlueprintId("p", "complete");
    useAppStore.getState().applyBlueprintToProject("p", "default");
    expect(useAppStore.getState().projectBlueprintId["p"]).toBe("default");  // switched
  });

  it("is a no-op when switching to the SAME blueprint (#1281)", () => {
    useAppStore.getState().setProjectBlueprintId("p", "default");
    useAppStore.getState().applyBlueprintToProject("p", "default");
    const s = useAppStore.getState();
    expect(s.projectBlueprintId["p"]).toBe("default");
    expect(s.uiScreens["p"]).toBeTruthy();                     // progress NOT wiped (refused no-op)
    expect(s.planStages["p"]).toEqual({ goal: "# Goal" });
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
});
