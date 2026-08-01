// The Algorithms rail's FOLDER TREE (#4107). Before this, the rail had exactly one level — each
// LANGUAGE was a folder — so all 50 Rust impls sat flat inside it. It now nests the way the Components
// rail does, from the harvested source layout.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsRail } from "./AlgorithmsRail";
import { buildKnowledge, type AlgoImpl } from "./lib/knowledge";

const im = (o: Partial<AlgoImpl> & Pick<AlgoImpl, "id" | "tech" | "name">): AlgoImpl =>
  ({ role: "algorithm", composes: [], ...o });

const noop = () => {};

const foldered = buildKnowledge({
  implementations: [
    im({ id: "job.rs", tech: "rust", name: "attachJob", folder: "src-tauri/src/console/pty" }),
    im({ id: "perf.rs", tech: "rust", name: "sample", folder: "src-tauri/src/observability" }),
  ],
});

describe("AlgorithmsRail folder tree (#4107)", () => {
  it("nests the harvested folders under the language", () => {
    // Sections default to OPEN, so the whole tree is visible without a click.
    render(<AlgorithmsRail graph={foldered} activeTech="rust" selectedImpl={null} onSelectImpl={noop} onSelectLang={noop} />);
    expect(screen.getByTitle("src-tauri")).toBeInTheDocument();
    expect(screen.getByTitle("src-tauri/src")).toBeInTheDocument();
    expect(screen.getByTitle("src-tauri/src/console")).toBeInTheDocument();
    expect(screen.getByTitle("src-tauri/src/console/pty")).toBeInTheDocument();
    expect(screen.getByTitle("src-tauri/src/observability")).toBeInTheDocument();
    // The impls sit inside their folders, not flat under the language.
    expect(screen.getByText("attachJob")).toBeInTheDocument();
    expect(screen.getByText("sample")).toBeInTheDocument();
  });

  it("collapsing a folder hides its whole subtree", () => {
    // What keeps a harvested library (hundreds of impls across dozens of folders) cheap to render.
    render(<AlgorithmsRail graph={foldered} activeTech="rust" selectedImpl={null} onSelectImpl={noop} onSelectLang={noop} />);
    fireEvent.click(screen.getByTitle("src-tauri/src/observability"));
    expect(screen.queryByText("sample")).toBeNull();
    expect(screen.getByText("attachJob")).toBeInTheDocument();   // its sibling branch is untouched
  });

  it("a collapsed folder still reports how much is inside it", () => {
    render(<AlgorithmsRail graph={foldered} activeTech="rust" selectedImpl={null} onSelectImpl={noop} onSelectLang={noop} />);
    fireEvent.click(screen.getByTitle("src-tauri"));             // collapse the root
    expect(screen.queryByText("attachJob")).toBeNull();
    // The count is the whole SUBTREE (2), not the root folder's own impls (0) — otherwise a deep tree
    // gives no sense of where the work lives.
    expect(screen.getByTitle("src-tauri").textContent).toContain("2");
  });

  it("still lists an UNFOLDERED library flat — the live store's 73 impls carry no folder", () => {
    const flat = buildKnowledge({ implementations: [im({ id: "merge.rs", tech: "rust", name: "merge" })] });
    render(<AlgorithmsRail graph={flat} activeTech="rust" selectedImpl={null} onSelectImpl={noop} onSelectLang={noop} />);
    expect(screen.getByText("merge")).toBeInTheDocument();
    expect(screen.queryByTitle("src-tauri")).toBeNull();
  });
});
