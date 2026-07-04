import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FocusedStageBody } from "./FocusedBodies";
import { STAGE_DEFS, makeBlueprints } from "../stages/blueprintBuiltins";
import type { Stage } from "../stages/focusedPlan";

describe("test_ui stage (#2274)", () => {
  it("STAGE_DEFS carries the test_ui section def (named, optional, component-library prompt)", () => {
    const def = STAGE_DEFS.test_ui;
    expect(def).toBeTruthy();
    expect(def.name).toBe("Test UI");
    expect(def.optional).toBe(true);
    expect(def.deps).toContain("features");
    expect(def.prompt).toMatch(/component library/i);
  });

  it("the UI Kit blueprint resolves a named test_ui stage plus the full standard set", () => {
    const bp = makeBlueprints().find((b) => b.id === "ui-kit");
    expect(bp).toBeTruthy();
    expect(bp!.category).toBe("greenfield");
    const keys = bp!.sections.map((s) => s.key);
    expect(keys).toContain("test_ui");
    // The planner stays fully capable — the standard stages are all present.
    for (const k of ["discovery", "deployment", "features", "streams"]) expect(keys).toContain(k);
    const testui = bp!.sections.find((s) => s.key === "test_ui")!;
    expect(testui.name).toBe("Test UI"); // resolved from STAGE_DEFS via mkStage
    expect(testui.optional).toBe(true); // never blocks plan completion
  });

  it("FocusedStageBody renders the Planner Components pane for a test_ui stage (#2314)", () => {
    const stage: Stage = {
      key: "test_ui", name: "Test UI", glyph: "◫", blurb: "", gate: "",
      index: 0, total: 1, status: "active", fraction: 0,
    };
    render(<FocusedStageBody stage={stage} />);
    // The Planner Components pane's Components ⇄ Full UI toggle is its signature.
    expect(screen.getByText("▤ Components")).toBeTruthy();
    expect(screen.getByText("▦ Full UI")).toBeTruthy();
  });
});
