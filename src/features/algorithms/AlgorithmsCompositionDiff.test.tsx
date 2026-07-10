// The composition-diff UI surface (#2781, Phase 2 slice 4): the canvas drift badge + the inspector
// "Composition check" section. Both are driven by the real model (composeDiff/driftConcepts over the
// seed KNOWLEDGE) plus a hand-made ExtractResult — so this exercises model → UI end to end.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsCanvas } from "./AlgorithmsCanvas";
import { AlgorithmsInspector } from "./AlgorithmsInspector";
import { KNOWLEDGE, KIND_ORDER, layoutKnowledge, nodeIndex } from "./lib/knowledge";
import { composeDiff, driftConcepts } from "./lib/compositionDiff";
import type { ExtractResult } from "./lib/extraction";

const layout = layoutKnowledge(KNOWLEDGE.nodes);
const allKinds = new Set(KIND_ORDER);
const byId = nodeIndex(KNOWLEDGE.nodes);

// merge-sort DECLARES composes {merge, divide-and-conquer}; the "real code" here calls merge (matched)
// + recursion (extra) but NOT divide-and-conquer (missing) → drift.
const driftExtract: ExtractResult = {
  matched: [{ concept: "merge-sort", tech: "typescript", file: "src/sort/merge.ts", line: 3 }],
  unmatched: [],
  duplicates: [],
  calls: [
    { from: "merge-sort", to: "merge", tech: "typescript" },
    { from: "merge-sort", to: "recursion", tech: "typescript" },
  ],
};
const diffs = composeDiff(KNOWLEDGE, driftExtract);
const drift = driftConcepts(diffs);

describe("AlgorithmsCanvas drift badge (#2781)", () => {
  it("paints a drift badge on each drifted node (and only those)", () => {
    const { container } = render(
      <AlgorithmsCanvas
        graph={KNOWLEDGE}
        layout={layout}
        selected={null}
        lit={null}
        activeKinds={allKinds}
        driftConcepts={drift}
        siteCounts={new Map([["merge-sort", 1]])}
        onSelect={() => {}}
      />,
    );
    const badges = container.querySelectorAll("[data-drift]");
    expect(badges.length).toBe(drift.size);
    expect(container.querySelector('[data-drift="merge-sort"]')).toBeTruthy();
    // Distinct from the dedup count badge (which also renders for merge-sort here).
    expect(container.querySelector(".algo-drift-badge")).not.toBe(container.querySelector(".algo-dedup-badge"));
  });

  it("renders NO drift badge without scan data", () => {
    const { container } = render(
      <AlgorithmsCanvas graph={KNOWLEDGE} layout={layout} selected={null} lit={null} activeKinds={allKinds} onSelect={() => {}} />,
    );
    expect(container.querySelectorAll("[data-drift]").length).toBe(0);
  });
});

describe("AlgorithmsInspector composition check (#2781)", () => {
  const mergeSort = byId.get("merge-sort")!;

  it("shows the matched / missing / extra rows for a drifted concept", () => {
    render(<AlgorithmsInspector graph={KNOWLEDGE} selected={mergeSort} activeTech="typescript" diff={diffs.get("merge-sort")} onSelectNode={() => {}} />);
    expect(screen.getByText("Composition check")).toBeTruthy();
    // Names repeat (relationships list also shows Merge / Divide & Conquer) → getAllByText.
    expect(screen.getAllByText("Merge").length).toBeGreaterThan(0);            // matched
    expect(screen.getAllByText("Divide & Conquer").length).toBeGreaterThan(0); // missing
    expect(screen.getAllByText("Recursion").length).toBeGreaterThan(0);        // extra
  });

  it("clicking a composition-check row jumps to that concept", () => {
    const onSelectNode = vi.fn();
    render(<AlgorithmsInspector graph={KNOWLEDGE} selected={mergeSort} activeTech="typescript" diff={diffs.get("merge-sort")} onSelectNode={onSelectNode} />);
    // The extra row (Recursion) is unique to the composition check for merge-sort — click it.
    fireEvent.click(screen.getByTitle("Found in code, not declared"));
    expect(onSelectNode).toHaveBeenCalledWith("recursion");
  });

  it("affirms an implemented concept with an all-empty diff (declares + calls nothing)", () => {
    // `merge` is implemented but declares no `composes` edges; a scan that finds it making no calls
    // yields an all-empty diff → the inspector affirms rather than listing rows.
    const matchExtract: ExtractResult = {
      matched: [{ concept: "merge", tech: "typescript", file: "x.ts", line: 1 }],
      unmatched: [],
      duplicates: [],
      calls: [],
    };
    const md = composeDiff(KNOWLEDGE, matchExtract).get("merge")!;
    expect([md.matched.length, md.missing.length, md.extra.length]).toEqual([0, 0, 0]);
    const merge = byId.get("merge")!;
    render(<AlgorithmsInspector graph={KNOWLEDGE} selected={merge} activeTech="typescript" diff={md} onSelectNode={() => {}} />);
    expect(screen.getByText("Composition check")).toBeTruthy();
    expect(screen.getByText(/Matches its declared composition/i)).toBeTruthy();
  });

  it("renders no Composition check without a diff", () => {
    render(<AlgorithmsInspector graph={KNOWLEDGE} selected={mergeSort} activeTech="typescript" onSelectNode={() => {}} />);
    expect(screen.queryByText("Composition check")).toBeNull();
  });
});
