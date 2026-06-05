import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PlanStageBar } from "../screens/projects/PlanStageBar";
import { defaultStageConfig, buildPlanStageState, enabledOrderedStages } from "../screens/projects/planStages";
import type { StageConfig } from "../screens/projects/planStages";

function titlesIn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[title]")).map((el) => el.getAttribute("title") ?? "");
}

describe("PlanStageBar", () => {
  it("renders one segment per enabled, applicable stage (UI hidden when not required)", () => {
    const cfg = defaultStageConfig();
    const state = buildPlanStageState({ requiresUi: false }); // ui -> N/A, hidden
    const { container } = render(<PlanStageBar config={cfg} state={state} />);
    const titles = titlesIn(container);
    // all enabled stages except the N/A ui stage
    const expected = enabledOrderedStages(cfg).filter((s) => s.id !== "ui").length;
    expect(titles.length).toBe(expected);
    expect(titles.some((t) => t.startsWith("UI"))).toBe(false);
    expect(titles.some((t) => t.startsWith("Context"))).toBe(true);
  });

  it("shows the UI stage when the project requires a UI", () => {
    const state = buildPlanStageState({ requiresUi: true, context: { resolved: 1, total: 1, coreConfirmed: true } });
    const { container } = render(<PlanStageBar config={defaultStageConfig()} state={state} />);
    expect(titlesIn(container).some((t) => t.startsWith("UI"))).toBe(true);
  });

  it("omits disabled stages", () => {
    const d = defaultStageConfig();
    const cfg: StageConfig = { ...d, enabled: { ...d.enabled, skills: false, automations: false } };
    const state = buildPlanStageState({ requiresUi: false });
    const { container } = render(<PlanStageBar config={cfg} state={state} />);
    const titles = titlesIn(container);
    expect(titles.some((t) => t.startsWith("Skills"))).toBe(false);
    expect(titles.some((t) => t.startsWith("Automations"))).toBe(false);
  });

  it("marks a satisfied stage complete in its tooltip", () => {
    const state = buildPlanStageState({ repoCount: 2 }); // repos gate done
    const { container } = render(<PlanStageBar config={defaultStageConfig()} state={state} />);
    expect(titlesIn(container).some((t) => t === "Repos — complete")).toBe(true);
  });

  it("flags a gate-blocked stage in its tooltip (#532)", () => {
    const state = buildPlanStageState({ repoCount: 2 });
    const { container } = render(<PlanStageBar config={defaultStageConfig()} state={state} blocked={new Set(["repos"])} />);
    expect(titlesIn(container).some((t) => t.includes("gate blocked"))).toBe(true);
  });
});
