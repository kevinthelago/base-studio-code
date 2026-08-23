// The Algorithms rail's filtering surface (#4128) — the domain dropdown (#3120) is GONE and search is
// the rail's one filter. Verifies: no domain control renders even for a library that carries the facet,
// a domained impl is still perfectly reachable (removing the control removed an organizer, not access),
// and search narrows by folder path the way the components rail does.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsRail } from "@/features/algorithms/AlgorithmsRail";
import { buildKnowledge, type AlgoImpl } from "@/features/algorithms/lib/knowledge";

// A synthetic impl — name distinct from id so a row's name and its trailing id don't collide in queries.
const im = (o: Partial<AlgoImpl> & Pick<AlgoImpl, "id" | "tech" | "name">): AlgoImpl =>
  ({ role: "algorithm", composes: [], ...o });

// A library that still CARRIES domains (the field is untouched by #4128) and also carries folders.
const domained = buildKnowledge({
  implementations: [
    im({ id: "dijkstra.rs", tech: "rust", name: "dijkstra", domain: "logistics", folder: "graphs" }),
    im({ id: "route.ts", tech: "typescript", name: "route", domain: "logistics", folder: "shared/lib" }),
    im({ id: "blur.ts", tech: "typescript", name: "blur", domain: "graphics", folder: "shared/img" }),
    im({ id: "plain.rs", tech: "rust", name: "plain" }), // no domain, no folder
  ],
});

const noop = () => {};
// The rail shows ONE language now — the page's active tab
// (`technology-tabs-for-components-and-algorithms`) — so a case has to say which.
const renderRail = (graph: ReturnType<typeof buildKnowledge>, tech: "rust" | "typescript" = "rust") =>
  render(<AlgorithmsRail graph={graph} activeTech={tech} selectedImpl={null} onSelectImpl={noop} />);

describe("AlgorithmsRail — the domain dropdown is retired (#4128)", () => {
  it("renders NO domain control, even for a library that carries the domain facet", () => {
    // The regression this guards: `domain` derives from the same `src` as `folder`, only collapsed to one
    // segment, so a domain selector offered a second and lossier organizer for an axis the folder tree
    // already covers — and the components rail has never had an equivalent.
    renderRail(domained);
    expect(screen.queryByLabelText("Filter by domain")).toBeNull();
    expect(screen.queryByText("All domains")).toBeNull();
    expect(screen.queryByText("logistics")).toBeNull();
  });

  it("still reaches every impl, domained or not — the control went, the algorithms did not", () => {
    renderRail(domained);
    expect(screen.getByText("dijkstra")).toBeTruthy(); // was `logistics`
    expect(screen.getByText("plain")).toBeTruthy();    // was untagged
  });

  it("keeps the search field as the rail's one filter", () => {
    renderRail(domained);
    const search = screen.getByLabelText("Search");
    expect(search).toBeTruthy();
    fireEvent.change(search, { target: { value: "dijk" } });
    expect(screen.getByText("dijkstra")).toBeTruthy();
    expect(screen.queryByText("plain")).toBeNull();
  });

  it("narrows by FOLDER PATH — how a domain-shaped collection is reached now", () => {
    // `shared/lib` and `shared/img` are distinct folders, so typing the path picks one out. This is the
    // affordance that replaces "pick a domain": it matches the components rail's `matchesQuery` (#3589).
    // Both impls are TypeScript, so the rail is rendered on that tab.
    renderRail(domained, "typescript");
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "shared/lib" } });
    expect(screen.getByText("route")).toBeTruthy();
    expect(screen.queryByText("blur")).toBeNull();
  });

  it("shows ONLY the active language — the tab is what switches it now", () => {
    // The rail used to open with a head per language and nest every one of them, so it answered two
    // questions at once: which language, and where inside it. The first moved to the page tabs.
    //
    // This also pins that scoping is by TECH and not by something incidental like folder: `dijkstra`
    // and `plain` are the Rust impls, `route` and `blur` the TypeScript ones, and they share no folder.
    renderRail(domained, "rust");
    expect(screen.getByText("dijkstra")).toBeTruthy();
    expect(screen.getByText("plain")).toBeTruthy();
    expect(screen.queryByText("route"), "a TypeScript impl must not appear on the Rust tab").toBeNull();
    expect(screen.queryByText("blur")).toBeNull();

    // And no language HEAD remains — the level itself is gone, not merely filtered to one entry.
    expect(screen.queryByText("Rust")).toBeNull();
    expect(screen.queryByText("TypeScript")).toBeNull();
  });
});
