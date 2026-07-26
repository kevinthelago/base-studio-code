import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FocusedStageBody } from "./FocusedBodies";
import { STAGE_DEFS } from "../stages/blueprintBuiltins";
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

  // (The "UI Kit blueprint includes test_ui" case was removed with the ui-kit blueprint, #3783 — the
  //  designer now generates UI in-app, so the component-library-review route is obsolete. The test_ui
  //  STAGE itself stays, covered by the STAGE_DEFS + rendering tests here.)

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
