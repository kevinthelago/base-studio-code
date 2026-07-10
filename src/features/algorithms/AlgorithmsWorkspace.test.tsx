// The Algorithms Workspace (#2761 · #2770 impl tier · #2773 rail) — render smoke test + the
// select→inspector interaction. NB: node names now appear in BOTH the rail and the canvas (and a
// selected concept also in the inspector), and complexities like "O(n log n)" repeat across cards —
// so use getAllByText for anything that isn't inspector-unique.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsWorkspace } from "./AlgorithmsWorkspace";

describe("AlgorithmsWorkspace", () => {
  it("renders the graph, the rail, and the empty-inspector legend", () => {
    render(<AlgorithmsWorkspace />);
    expect(screen.getByText(/concepts ·/)).toBeTruthy();       // toolbar count (unique)
    // "Concepts" is both the GraphRail header (#2773) and the concept kind-filter chip — so it repeats.
    expect(screen.getAllByText("Concepts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Merge Sort").length).toBeGreaterThan(0); // rail + canvas
    expect(screen.getByText("operates on")).toBeTruthy();      // inspector legend (unique)
  });

  it("selecting a node shows its details in the inspector", () => {
    render(<AlgorithmsWorkspace />);
    fireEvent.click(screen.getAllByText("Merge Sort")[0]);
    expect(screen.getByText(/Split, sort halves, merge/)).toBeTruthy(); // summary (inspector-unique)
    expect(screen.getAllByText("O(n log n)").length).toBeGreaterThan(0); // complexity (repeats)
  });

  it("shows the active-tech implementation + its builds-on for a selected concept (#2770)", () => {
    render(<AlgorithmsWorkspace />);
    fireEvent.click(screen.getAllByText("Merge Sort")[0]);
    // TypeScript is the default tech — the impl section shows the TS code that calls merge...
    expect(screen.getByText((c) => c.includes("return merge(left, right, cmp);"))).toBeTruthy();
    // ...and lists the merge primitive it builds on.
    expect(screen.getByText("Builds on")).toBeTruthy();
    expect(screen.getByText("merge.ts")).toBeTruthy();
  });
});
