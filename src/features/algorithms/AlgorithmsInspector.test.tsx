// The Algorithms inspector (#2761) + its Visualization pane (#3177/#3199). The animation is ALWAYS
// rendered inline (no Code | Visualization toggle) as an auto-playing preview above the code; clicking
// it fills the screen with a full player + an editable "provide your own state" input. An impl without
// a registered visualization keeps exactly today's code-only pane.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
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

// A plain impl with NO registered visualization — the control group for "code-only, no preview".
const FIB: AlgoImpl = {
  id: "fibonacci.ts",
  tech: "typescript",
  role: "algorithm",
  name: "fibonacci",
  composes: [],
  code: "export function fibonacci(n: number): number { return n; }",
};

const graph: KnowledgeGraph = { implementations: [SORT, FIB] };

describe("AlgorithmsInspector — Visualization pane (#3177/#3199)", () => {
  it("renders the visualization inline (no toggle) as a preview above the code", () => {
    const { container } = render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} />);
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

  it("clicking the preview fills the screen with a full player + an editable input", () => {
    render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} />);
    fireEvent.click(screen.getByRole("button", { name: /expand visualization/i }));
    const dialog = screen.getByRole("dialog", { name: "Visualization" });
    // The fullscreen player has full controls (the inline preview did not).
    expect(within(dialog).getByLabelText("Step forward")).toBeTruthy();
    // The editable "provide your own state" field is seeded with the example default.
    const input = within(dialog).getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("5, 2, 9, 1, 6, 3, 8, 4, 7");
    expect(within(dialog).getByRole("button", { name: "Run" })).toBeTruthy();
  });

  it("Run re-runs the trace on the user's own input", () => {
    render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} />);
    fireEvent.click(screen.getByRole("button", { name: /expand visualization/i }));
    const dialog = screen.getByRole("dialog", { name: "Visualization" });
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "3, 1, 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    // Frame 0 of the custom input renders exactly its 3 cells in the fullscreen stage.
    const stage = dialog.querySelector(".algo-viz-fullscreen-stage")!;
    expect(stage.querySelectorAll(".array-cell").length).toBe(3);
  });

  it("invalid input surfaces an error and keeps the last good run", () => {
    render(<AlgorithmsInspector graph={graph} focusedImpl={SORT} />);
    fireEvent.click(screen.getByRole("button", { name: /expand visualization/i }));
    const dialog = screen.getByRole("dialog", { name: "Visualization" });
    const stage = dialog.querySelector(".algo-viz-fullscreen-stage")!;
    const before = stage.querySelectorAll(".array-cell").length; // the default 9-cell run
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "abc" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    expect(within(dialog).getByText(/is not a number/i)).toBeTruthy();
    // The prior run is untouched — the invalid Run did not rebuild the player.
    expect(stage.querySelectorAll(".array-cell").length).toBe(before);
  });

  it("shows no visualization for an impl without one — code only, no preview", () => {
    const { container } = render(<AlgorithmsInspector graph={graph} focusedImpl={FIB} />);
    expect(screen.queryByRole("button", { name: /expand visualization/i })).toBeNull();
    expect(container.querySelector(".array-cell")).toBeNull();
    expect(container.querySelector(".algo-code")?.textContent).toContain("fibonacci");
  });

  it("prompts for a selection in the empty state", () => {
    render(<AlgorithmsInspector graph={graph} focusedImpl={null} />);
    expect(screen.getByText(/Select an implementation/i)).toBeTruthy();
  });
});
