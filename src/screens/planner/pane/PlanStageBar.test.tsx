import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PlanStageBar } from "./PlanStageBar";
import { makeBlueprints, type BlueprintSection } from "../stages/blueprints";
import { planStateToSignals } from "../stages/planStageDerive";
import { buildPlanStageState } from "../stages/planStages";

function titlesIn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[title]")).map((el) => el.getAttribute("title") ?? "");
}
const defaultSections = (): BlueprintSection[] => makeBlueprints()[0].sections;
const setEnabled = (sections: BlueprintSection[], key: string, enabled: boolean): BlueprintSection[] =>
  sections.map((s) => (s.key === key ? { ...s, enabled } : s));
const signalsFrom = (over: Parameters<typeof buildPlanStageState>[0] = {}) =>
  planStateToSignals(buildPlanStageState(over));

describe("PlanStageBar", () => {
  it("renders one segment per enabled, applicable section (UI hidden when not required)", () => {
    // The default UI is now optional (always shown, #676); clear that here so this test
    // exercises the appliesWhen-hiding path for a required UI section.
    const sections = defaultSections().map((s) => (s.key === "ui" ? { ...s, optional: false } : s));
    const { container } = render(<PlanStageBar sections={sections} signals={signalsFrom({ requiresUi: false })} />);
    const titles = titlesIn(container);
    const expected = sections.filter((s) => s.enabled && s.key !== "ui").length;
    expect(titles.length).toBe(expected);
    expect(titles.some((t) => t.startsWith("UI"))).toBe(false);
    expect(titles.some((t) => t.startsWith("Context"))).toBe(true);
  });

  it("shows the UI section when the project requires a UI", () => {
    const signals = signalsFrom({ requiresUi: true, context: { resolved: 1, total: 1, coreConfirmed: true } });
    const { container } = render(<PlanStageBar sections={defaultSections()} signals={signals} />);
    expect(titlesIn(container).some((t) => t.startsWith("UI"))).toBe(true);
  });

  it("omits disabled sections", () => {
    let sections = defaultSections();
    sections = setEnabled(sections, "skills", false);
    sections = setEnabled(sections, "automations", false);
    const { container } = render(<PlanStageBar sections={sections} signals={signalsFrom({ requiresUi: false })} />);
    const titles = titlesIn(container);
    expect(titles.some((t) => t.startsWith("Skills"))).toBe(false);
    expect(titles.some((t) => t.startsWith("Automations"))).toBe(false);
  });

  it("marks a satisfied section complete in its tooltip", () => {
    const sections = setEnabled(defaultSections(), "repos", true);
    const { container } = render(<PlanStageBar sections={sections} signals={signalsFrom({ repoCount: 2 })} />);
    expect(titlesIn(container).some((t) => t === "Repos — complete")).toBe(true);
  });

  it("flags a gate-blocked section in its tooltip (#532)", () => {
    const sections = setEnabled(defaultSections(), "repos", true);
    const { container } = render(
      <PlanStageBar sections={sections} signals={signalsFrom({ repoCount: 2 })} blocked={new Set(["repos"])} />,
    );
    expect(titlesIn(container).some((t) => t.includes("gate blocked"))).toBe(true);
  });

  it("pulses + flags a highlighted incomplete section (locked-Triage feedback)", () => {
    const sections = defaultSections();
    const { container } = render(
      <PlanStageBar sections={sections} signals={signalsFrom({ requiresUi: false })} highlight={new Set(["context"])} />,
    );
    expect(container.querySelector(".attn-pulse")).not.toBeNull();
    expect(titlesIn(container).some((t) => t.startsWith("Context") && t.includes("incomplete"))).toBe(true);
  });
});
