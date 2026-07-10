// The Algorithms Workspace (#2761) — a render smoke test + the select→inspector interaction.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsWorkspace } from "./AlgorithmsWorkspace";

describe("AlgorithmsWorkspace (#2761)", () => {
  it("renders the graph — the concept count and a node card", () => {
    render(<AlgorithmsWorkspace />);
    expect(screen.getByText(/concepts ·/)).toBeTruthy();
    expect(screen.getByText("Merge Sort")).toBeTruthy();
    // The empty inspector shows the relationship legend until a node is picked.
    expect(screen.getByText("operates on")).toBeTruthy();
  });

  it("selecting a node shows its details in the inspector", () => {
    render(<AlgorithmsWorkspace />);
    fireEvent.click(screen.getByText("Merge Sort"));
    // The inspector now carries the node's summary + its complexity chip.
    expect(screen.getByText(/Split, sort halves, merge/)).toBeTruthy();
    expect(screen.getByText("O(n log n)")).toBeTruthy();
  });
});
