// The Algorithms rail (#2899) domain-facet affordance (#3120) — the OPTIONAL domain filter that
// COMPLEMENTS the language-folder view. Verifies: the filter appears only when the library carries a
// domain facet (no regression when it doesn't), and picking a domain narrows the language folders to
// that domain's collection while leaving the language-folder structure intact.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsRail } from "./AlgorithmsRail";
import { buildKnowledge, type AlgoImpl } from "./lib/knowledge";

// A synthetic impl — name distinct from id so a row's name and its trailing id id don't collide in queries.
const im = (o: Partial<AlgoImpl> & Pick<AlgoImpl, "id" | "tech" | "name">): AlgoImpl =>
  ({ role: "algorithm", composes: [], ...o });

// A library with a logistics collection across both languages, one graphics impl, and one untagged impl.
const domained = buildKnowledge({
  implementations: [
    im({ id: "dijkstra.rs", tech: "rust", name: "dijkstra", domain: "logistics" }),
    im({ id: "route.ts", tech: "typescript", name: "route", domain: "logistics" }),
    im({ id: "blur.ts", tech: "typescript", name: "blur", domain: "graphics" }),
    im({ id: "plain.rs", tech: "rust", name: "plain" }), // no domain
  ],
});

const noop = () => {};

describe("AlgorithmsRail domain filter (#3120)", () => {
  it("shows no domain filter when the library carries no domain facet (no regression)", () => {
    const plain = buildKnowledge({ implementations: [im({ id: "x.rs", tech: "rust", name: "x" })] });
    render(<AlgorithmsRail graph={plain} activeTech="rust" selectedImpl={null} onSelectImpl={noop} onSelectLang={noop} />);
    expect(screen.queryByLabelText("Filter by domain")).toBeNull();
    expect(screen.getByText("x")).toBeTruthy(); // the language-folder view still renders
  });

  it("offers a domain filter when the library carries domains", () => {
    render(<AlgorithmsRail graph={domained} activeTech="rust" selectedImpl={null} onSelectImpl={noop} onSelectLang={noop} />);
    expect(screen.getByLabelText("Filter by domain")).toBeTruthy();
    // Unfiltered, both a domained impl and the untagged one show.
    expect(screen.getByText("dijkstra")).toBeTruthy();
    expect(screen.getByText("plain")).toBeTruthy();
  });

  it("picking a domain narrows the language folders to that domain's collection", () => {
    render(<AlgorithmsRail graph={domained} activeTech="rust" selectedImpl={null} onSelectImpl={noop} onSelectLang={noop} />);
    // Open the filter and pick "logistics".
    fireEvent.click(screen.getByLabelText("Filter by domain"));
    fireEvent.click(screen.getByText("logistics"));
    // Logistics impls remain — across BOTH languages (the collection cross-cuts tech)…
    expect(screen.getByText("dijkstra")).toBeTruthy(); // rust
    expect(screen.getByText("route")).toBeTruthy();    // typescript
    // …and the untagged impl + the other domain drop out.
    expect(screen.queryByText("plain")).toBeNull();
    expect(screen.queryByText("blur")).toBeNull();
  });
});
