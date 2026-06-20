import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { buildClaudeDesignBrief } from "./claudeDesignBrief";
import { makeBlueprints } from "../stages/blueprints";
import { PlanPreviewPane } from "../pane/PlanPreviewPane";
import { useAppStore } from "../../../store";

describe("buildClaudeDesignBrief (#634)", () => {
  it("lists the screens + the export-back instruction", () => {
    const b = buildClaudeDesignBrief(["Dashboard", "Settings"], { projectName: "Acme", stack: "React + TS" });
    expect(b).toMatch(/Design brief for Acme/);
    expect(b).toMatch(/\*\*Dashboard\*\*/);
    expect(b).toMatch(/\*\*Settings\*\*/);
    expect(b).toMatch(/React \+ TS/);
    expect(b).toMatch(/empty, loading, error/);
    expect(b).toMatch(/Drop files/);
  });
  it("handles no screens gracefully", () => {
    expect(buildClaudeDesignBrief([])).toMatch(/no screens defined yet/);
  });
});

describe("default blueprint accepts Claude Design files (#634)", () => {
  it("the default blueprint has a UI stage (where the design files are dropped + previewed) (#897 Phase 4c: these are stage features, not pipelines)", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    expect(def.sections.some((s) => s.key === "ui")).toBe(true);
  });
});

describe("PlanPreviewPane Claude Design brief button (#634)", () => {
  beforeEach(() => {
    useAppStore.setState({ uiScreens: { p: ["Dashboard"] }, uiApproved: {}, stagePreview: {}, stagePipelineRuns: {} });
  });

  it("offers a Claude Design brief once screens are declared, and copies it", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PlanPreviewPane projectKey="p" />);
    const btn = screen.getByRole("button", { name: /Claude Design brief/i });
    fireEvent.click(btn);
    expect(writeText).toHaveBeenCalled();
    expect(String(writeText.mock.calls[0][0])).toMatch(/\*\*Dashboard\*\*/);
  });
});
