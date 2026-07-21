// The Algorithms inspector (#2761) + its inline Visualization preview (#3177/#3199/#3205). The animation
// is ALWAYS rendered inline (no Code | Visualization toggle) as an auto-playing preview above the code.
// Clicking it does NOT open a modal — it lifts to the workbench (`onExpandViz`), which promotes the
// animation to the full graph canvas (`VizStage`, covered by its own test). An impl without a registered
// visualization keeps exactly today's code-only pane.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsInspector } from "./AlgorithmsInspector";
import type { AlgoImpl, KnowledgeGraph } from "./lib/knowledge";

// The seeded sort impl — the id `sort.ts` is what `vizForImpl` keys the visualization on.
const SORT: AlgoImpl = {
  id: "sort.ts",
  tech: "typescript",
  role: "algorithm",
  name: "sort",
  summary: "Insertion sort as a step-yielding generator.",
  composes: ["typescript.number"],
  code: "export function* sortSteps(a: number[]) { /* ... */ }",
};

// A plain impl with NO registered visualization — the control group for "code-only, no preview". (It used
// to be fibonacci, which gained a scalar/accumulate program in #3220; gcd has no trace-program yet.)
const NO_VIZ: AlgoImpl = {
  id: "euclid-gcd.rs",
  tech: "rust",
  role: "algorithm",
  name: "gcd",
  composes: [],
  code: "pub fn gcd(a: u64, b: u64) -> u64 { if b == 0 { a } else { gcd(b, a % b) } }",
};

const graph: KnowledgeGraph = { implementations: [SORT, NO_VIZ] };
const noop = () => {};

describe("AlgorithmsInspector — inline Visualization preview (#3199/#3205)", () => {
  it("renders the visualization inline (no toggle) as a preview above the code", () => {
    const { container } = render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} onExpandViz={noop} />);
    // No Code | Visualization toggle anymore.
    expect(screen.queryByRole("button", { name: "Code" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Visualization" })).toBeNull();
    // The inline preview renders its first frame (the <ArrayView> cells) right away.
    expect(container.querySelectorAll(".array-cell").length).toBeGreaterThan(0);
    // It is a clickable expand affordance; its own transport is hidden (controls={false}).
    expect(screen.getByRole("button", { name: /expand visualization/i })).toBeTruthy();
    expect(screen.queryByLabelText("Step forward")).toBeNull();
    // The code stays visible below the preview.
    expect(container.querySelector(".algo-code")?.textContent).toContain("sortSteps");
  });

  it("clicking the preview lifts the expand to the workbench (onExpandViz), NOT a modal", () => {
    const onExpandViz = vi.fn();
    render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} onExpandViz={onExpandViz} />);
    fireEvent.click(screen.getByRole("button", { name: /expand visualization/i }));
    expect(onExpandViz).toHaveBeenCalledTimes(1);
    // No dialog/modal is mounted by the inspector — the take-over is the workbench's overlay.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enter/Space on the focused preview also expands (keyboard affordance)", () => {
    const onExpandViz = vi.fn();
    render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} onExpandViz={onExpandViz} />);
    const preview = screen.getByRole("button", { name: /expand visualization/i });
    fireEvent.keyDown(preview, { key: "Enter" });
    fireEvent.keyDown(preview, { key: " " });
    expect(onExpandViz).toHaveBeenCalledTimes(2);
  });

  it("shows no preview without onExpandViz, or for an impl without a visualization", () => {
    // No expand handler wired → no inline preview (the workbench always wires it; this guards the gate).
    const { container: a } = render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} />);
    expect(a.querySelector(".array-cell")).toBeNull();
    // A viz-less impl → code only, no preview, even with a handler.
    const { container: b } = render(<AlgorithmsInspector graph={graph} focusedImpl={NO_VIZ} onExpandViz={noop} />);
    expect(screen.queryByRole("button", { name: /expand visualization/i })).toBeNull();
    expect(b.querySelector(".array-cell")).toBeNull();
    expect(b.querySelector(".algo-code")?.textContent).toContain("gcd");
  });

  it("prompts for a selection in the empty state", () => {
    render(<AlgorithmsInspector graph={graph} focusedImpl={null} />);
    expect(screen.getByText(/Select an implementation/i)).toBeTruthy();
  });
});
