import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { buildClaudeDesignBrief } from "../screens/projects/claudeDesignBrief";
import { makeBlueprints } from "../screens/projects/blueprints";
import { PlanPreviewPane } from "../screens/projects/PlanPreviewPane";
import { useAppStore } from "../store";

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
  it("the default blueprint's UI stage carries the file-intake pipeline", () => {
    const def = makeBlueprints().find((b) => b.id === "default")!;
    const ui = def.sections.find((s) => s.key === "ui")!;
    expect(ui.pipelines.map((p) => p.id)).toContain("file-intake");
    expect(ui.pipelines.map((p) => p.id)).toContain("render-preview");
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
