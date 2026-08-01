// The Algorithms rail's FOLDER TREE (#4107, brought to components parity by #4128). Before #4107 the
// rail had exactly one level — each LANGUAGE was a folder — so all 50 Rust impls sat flat inside it. It
// now nests the way the Components rail does, from the harvested source layout, through the SAME shared
// `buildFolderTree` + `RailFolderRow` the Designs rail renders — including the folder tooltip
// (`folder: <path>`) and the trailing "ungrouped" bucket.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsRail } from "./AlgorithmsRail";
import { UNGROUPED_LABEL } from "@/shared/lib/core/folderTree";
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

const renderRail = (graph: ReturnType<typeof buildKnowledge>) =>
  render(<AlgorithmsRail graph={graph} activeTech="rust" selectedImpl={null} onSelectImpl={noop} onSelectLang={noop} />);

describe("AlgorithmsRail folder tree (#4107/#4128)", () => {
  it("nests the harvested folders under the language, tooltipped like the components rail", () => {
    // Sections default to OPEN, so the whole tree is visible without a click. The `folder: ` tooltip
    // prefix is the shared `RailFolderRow`'s — the algorithms rail used a bare path before #4128.
    renderRail(foldered);
    expect(screen.getByTitle("folder: src-tauri")).toBeInTheDocument();
    expect(screen.getByTitle("folder: src-tauri/src")).toBeInTheDocument();
    expect(screen.getByTitle("folder: src-tauri/src/console")).toBeInTheDocument();
    expect(screen.getByTitle("folder: src-tauri/src/console/pty")).toBeInTheDocument();
    expect(screen.getByTitle("folder: src-tauri/src/observability")).toBeInTheDocument();
    // The impls sit inside their folders, not flat under the language.
    expect(screen.getByText("attachJob")).toBeInTheDocument();
    expect(screen.getByText("sample")).toBeInTheDocument();
  });

  it("collapsing a folder hides its whole subtree", () => {
    // What keeps a harvested library (hundreds of impls across dozens of folders) cheap to render.
    renderRail(foldered);
    fireEvent.click(screen.getByTitle("folder: src-tauri/src/observability"));
    expect(screen.queryByText("sample")).toBeNull();
    expect(screen.getByText("attachJob")).toBeInTheDocument();   // its sibling branch is untouched
  });

  it("a collapsed folder still reports how much is inside it", () => {
    renderRail(foldered);
    fireEvent.click(screen.getByTitle("folder: src-tauri"));      // collapse the root
    expect(screen.queryByText("attachJob")).toBeNull();
    // The count is the whole SUBTREE (2), not the root folder's own impls (0) — otherwise a deep tree
    // gives no sense of where the work lives.
    expect(screen.getByTitle("folder: src-tauri").textContent).toContain("2");
  });

  it("buckets unfoldered impls into a trailing `ungrouped` folder, not a flat spill (#4128)", () => {
    // The components rail has always done this; the algorithms rail used to render them loose beside the
    // tree. It matters HERE more than there: the seeded classics carry no `src`, so in the live library
    // the unfoldered set is the majority, and loose rows next to folders read as two competing lists.
    const mixed = buildKnowledge({
      implementations: [
        im({ id: "job.rs", tech: "rust", name: "attachJob", folder: "src-tauri/src/console/pty" }),
        im({ id: "merge.rs", tech: "rust", name: "merge" }),
      ],
    });
    renderRail(mixed);
    const bucket = screen.getByTitle("records with no folder");
    expect(bucket).toBeInTheDocument();
    expect(bucket.textContent).toContain(UNGROUPED_LABEL);
    expect(screen.getByText("merge")).toBeInTheDocument();
    // Collapsing the bucket hides its rows, exactly like any other folder.
    fireEvent.click(bucket);
    expect(screen.queryByText("merge")).toBeNull();
    expect(screen.getByText("attachJob")).toBeInTheDocument();
  });

  it("still lists a WHOLLY unfoldered library flat — no bucket, no blank folder", () => {
    // The zero-regression case: a library that has never been foldered renders as the plain list it
    // always did rather than collapsing under one `ungrouped` node.
    const flat = buildKnowledge({ implementations: [im({ id: "merge.rs", tech: "rust", name: "merge" })] });
    renderRail(flat);
    expect(screen.getByText("merge")).toBeInTheDocument();
    expect(screen.queryByTitle("folder: src-tauri")).toBeNull();
    expect(screen.queryByTitle("records with no folder")).toBeNull();
  });
});
