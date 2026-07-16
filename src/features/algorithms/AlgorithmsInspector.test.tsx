// The Algorithms inspector (#2761) + its Visualization pane (#3177) — the Code | Visualization toggle
// appears only for an impl with a registered visualization (the seeded `sort.ts`), switching swaps the
// code panel for the live <TracePlayer>, and an impl without one keeps exactly today's code-only pane.
import { describe, it, expect } from "vitest";
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

// A plain impl with NO registered visualization — the control group for "code pane unchanged".
const FIB: AlgoImpl = {
  id: "fibonacci.ts",
  tech: "typescript",
  role: "algorithm",
  name: "fibonacci",
  composes: [],
  code: "export function fibonacci(n: number): number { return n; }",
};

const graph: KnowledgeGraph = { implementations: [SORT, FIB] };

describe("AlgorithmsInspector — Visualization pane (#3177)", () => {
  it("shows the Code | Visualization toggle for an impl with a visualization", () => {
    render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} />);
    expect(screen.getByRole("button", { name: "Code" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Visualization" })).toBeTruthy();
  });

  it("defaults to the Code pane (code shown, no player)", () => {
    const { container } = render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} />);
    expect(container.querySelector(".algo-code")?.textContent).toContain("sortSteps");
    // No player transport yet.
    expect(screen.queryByLabelText("Step forward")).toBeNull();
    expect(container.querySelector(".array-cell")).toBeNull();
  });

  it("switches to the live player on the Visualization toggle (code pane replaced)", () => {
    const { container } = render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} />);
    fireEvent.click(screen.getByRole("button", { name: "Visualization" }));
    // The player is mounted — its transport + the <ArrayView> cells render the first frame.
    expect(screen.getByLabelText("Step forward")).toBeTruthy();
    expect(container.querySelectorAll(".array-cell").length).toBeGreaterThan(0);
    // The code pane is gone.
    expect(container.querySelector(".algo-code")).toBeNull();
  });

  it("advancing the player animates the sort (a swap verb appears on the cells)", () => {
    const { container } = render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} />);
    fireEvent.click(screen.getByRole("button", { name: "Visualization" }));
    // Step forward a few frames; the seeded input needs a swap early, so a data-op shows up.
    const stepped = () => container.querySelector('.array-cell[data-op]');
    for (let i = 0; i < 6 && !stepped(); i++) fireEvent.click(screen.getByLabelText("Step forward"));
    expect(container.querySelector('.array-cell[data-op]')).toBeTruthy();
  });

  it("keeps the Code pane unchanged for an impl WITHOUT a visualization (no toggle)", () => {
    const { container } = render(<AlgorithmsInspector graph={graph} focusedImpl={FIB} />);
    expect(screen.queryByRole("button", { name: "Visualization" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Code" })).toBeNull();
    expect(container.querySelector(".algo-code")?.textContent).toContain("fibonacci");
  });

  it("prompts for a selection in the empty state", () => {
    render(<AlgorithmsInspector graph={graph} focusedImpl={null} />);
    expect(screen.getByText(/Select an implementation/i)).toBeTruthy();
  });
});
