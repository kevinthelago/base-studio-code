// The extraction UI surface (#2777, Phase 2 slice 2): the node dedup badge on the canvas + the
// "Implementations found" list in the inspector. Both are driven purely by injected extraction data —
// with none, NO badges render (the degraded default), which the existing Workspace tests rely on.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AlgorithmsCanvas } from "./AlgorithmsCanvas";
import { AlgorithmsInspector } from "./AlgorithmsInspector";
import { KNOWLEDGE, KIND_ORDER, layoutKnowledge, nodeIndex } from "./lib/knowledge";
import type { ExtractSite } from "./lib/extraction";

const layout = layoutKnowledge(KNOWLEDGE.nodes);
const allKinds = new Set(KIND_ORDER);

function renderCanvas(props: Partial<Parameters<typeof AlgorithmsCanvas>[0]> = {}) {
  return render(
    <AlgorithmsCanvas
      graph={KNOWLEDGE}
      layout={layout}
      selected={null}
      lit={null}
      activeKinds={allKinds}
      onSelect={() => {}}
      {...props}
    />,
  );
}

describe("AlgorithmsCanvas dedup badge (#2777)", () => {
  it("renders a WARNING-tone count badge for a >1-site (duplicate) concept and a plain one for a single site", () => {
    renderCanvas({
      siteCounts: new Map([["merge-sort", 2], ["binary-search", 1]]),
      dupConcepts: new Set(["merge-sort"]),
    });
    const dup = screen.getByTitle(/duplicated across 2 sites/i);
    expect(dup.textContent).toBe("2");
    expect(dup.getAttribute("style")).toMatch(/--state-wait/); // painted the warning tone
    const single = screen.getByTitle(/^1 implementation found in code$/i);
    expect(single.textContent).toBe("1");
  });

  it("renders NO dedup badge when there is no extraction data", () => {
    renderCanvas();
    expect(screen.queryByTitle(/implementation found in code/i)).toBeNull();
    expect(screen.queryByTitle(/duplicated across/i)).toBeNull();
  });
});

describe("AlgorithmsInspector implementations-found list (#2777)", () => {
  const mergeSort = nodeIndex(KNOWLEDGE.nodes).get("merge-sort")!;
  const sites: ExtractSite[] = [
    { concept: "merge-sort", tech: "typescript", file: "src/sort/merge.ts", line: 3 },
    { concept: "merge-sort", tech: "rust", file: "crates/sort/src/merge.rs", line: 12 },
  ];

  it("lists the selected concept's sites as tech · file:line", () => {
    render(<AlgorithmsInspector graph={KNOWLEDGE} selected={mergeSort} activeTech="typescript" sites={sites} onSelectNode={() => {}} />);
    expect(screen.getByText(/Implementations found · 2/)).toBeTruthy();
    expect(screen.getByText("src/sort/merge.ts:3")).toBeTruthy();
    expect(screen.getByText("crates/sort/src/merge.rs:12")).toBeTruthy();
  });

  it("renders nothing when there are no sites", () => {
    render(<AlgorithmsInspector graph={KNOWLEDGE} selected={mergeSort} activeTech="typescript" sites={[]} onSelectNode={() => {}} />);
    expect(screen.queryByText(/Implementations found/)).toBeNull();
  });
});
