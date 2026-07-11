// The Algorithms Workspace (#2761 · #2863 per-kit graph) — render smoke test + the select→inspector
// interaction over the per-kit graph. A concept IS its implementation, so the center graph's nodes are
// the active kit's IMPLS; every impl name appears in BOTH the rail and the canvas, so use getAllByText
// for anything that isn't inspector-unique (impl code, the role chip, section labels).
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsWorkspace } from "./AlgorithmsWorkspace";

// The page docks the librarian session (#2787), which mounts an xterm terminal — stub xterm (it can't
// initialize in jsdom) + the layout globals useScreenSession needs, so rendering the page doesn't crash.
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80; rows = 24; options: Record<string, unknown> = {};
    loadAddon = vi.fn(); open = vi.fn(); write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() })); focus = vi.fn(); dispose = vi.fn();
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeAll(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

describe("AlgorithmsWorkspace", () => {
  it("renders the per-kit graph, the rail, and the empty-inspector legend", () => {
    render(<AlgorithmsWorkspace />);
    expect(screen.getByText(/impls ·/)).toBeTruthy();               // breadcrumb count "N impls · M links"
    // The active (TypeScript) kit's impls appear as nodes — in BOTH the rail and the canvas.
    expect(screen.getAllByText("mergeSort (TypeScript)").length).toBeGreaterThan(0);
    expect(screen.getByText("operates on")).toBeTruthy();           // empty-inspector legend (unique)
  });

  it("selecting an impl node shows its code + role in the inspector", () => {
    render(<AlgorithmsWorkspace />);
    fireEvent.click(screen.getAllByText("mergeSort (TypeScript)")[0]);
    // The default (TypeScript) impl's code (inspector-unique)…
    expect(screen.getByText((c) => c.includes("return merge(left, right, cmp);"))).toBeTruthy();
    // …tagged as an algorithm (the role chip).
    expect(screen.getByText("algorithm")).toBeTruthy();
  });

  it("an algorithm impl lists the impls it builds on (#2863)", () => {
    render(<AlgorithmsWorkspace />);
    fireEvent.click(screen.getAllByText("mergeSort (TypeScript)")[0]);
    expect(screen.getByText("Builds on")).toBeTruthy();
    // The merge primitive it composes appears in the builds-on list (also in rail + canvas).
    expect(screen.getAllByText("merge.ts").length).toBeGreaterThan(1);
  });

  it("switching kits re-languages the selected impl to the same concept's impl (#2863)", () => {
    render(<AlgorithmsWorkspace />);
    // Both seeded kits are offered in the rail's Kits section.
    expect(screen.getByText("TypeScript")).toBeTruthy();
    expect(screen.getByText("Rust")).toBeTruthy();
    fireEvent.click(screen.getAllByText("mergeSort (TypeScript)")[0]);
    expect(screen.getByText((c) => c.includes("return merge(left, right, cmp);"))).toBeTruthy();
    // Switching to the Rust kit re-anchors the selection to merge-sort.rs — the Rust impl shows.
    fireEvent.click(screen.getByText("Rust"));
    expect(screen.getByText((c) => c.includes("merge(&left, &right)"))).toBeTruthy();
    expect(screen.getAllByText("merge.rs").length).toBeGreaterThan(0);
  });

  it("the rail groups the kit's impls by role; selecting a primitive shows its code (#2863)", () => {
    render(<AlgorithmsWorkspace />);
    // `Array (TypeScript)` is a primitive — it appears in the rail's Primitives section and as a node.
    fireEvent.click(screen.getAllByText("Array (TypeScript)")[0]);
    // The inspector shows it directly — the "primitive" chip + its code.
    expect(screen.getByText("primitive")).toBeTruthy();
    expect(screen.getByText((c) => c.includes("xs.push(4)"))).toBeTruthy();
  });

  it("kits are navigable on the graph — pop to the kits index and drill into a kit (#2863)", () => {
    const { container } = render(<AlgorithmsWorkspace />);
    // The header breadcrumb pops up to the kits-index layer (the coarse layer above the kit graph).
    fireEvent.click(screen.getByRole("button", { name: "Kits" }));
    // The index renders a card per language kit.
    const rustCard = container.querySelector('[data-kit="rust"]');
    expect(rustCard).toBeTruthy();
    expect(container.querySelector('[data-kit="typescript"]')).toBeTruthy();
    // Drilling into the Rust kit opens its graph — a Rust impl there shows the Rust code.
    fireEvent.click(rustCard!);
    fireEvent.click(screen.getAllByText("merge_sort (Rust)")[0]);
    expect(screen.getByText((c) => c.includes("merge(&left, &right)"))).toBeTruthy();
  });
});
