// The Algorithms Workspace (#2761 · #2863 per-kit graph · #2899 language-folder rail) — render smoke test
// + the select→inspector interaction. The LEFT PANE is a folder per language (its impls the rows); the
// CENTER is the active language's graph. Every impl name appears in BOTH the rail and the canvas, so use
// getAllByText for anything that isn't inspector-unique (impl code, the role chip).
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
  it("renders a folder per language, its impls, and the on-graph relationships legend (#2909)", () => {
    render(<AlgorithmsWorkspace />);
    // Each language is a folder head in the rail (mirroring the Components tech folders, #2899). The seed
    // is Rust-only (#2760), so the one kit is Rust.
    expect(screen.getByText("Rust")).toBeTruthy();
    // Folders default open, so the active (Rust) kit's impls show — as rail rows + canvas nodes.
    expect(screen.getAllByText("merge_sort (Rust)").length).toBeGreaterThan(0);
    // The on-graph legend (not the inspector) keys the edge types present in the kit — `composes` is live
    // (merge-sort.rs composes merge.rs).
    expect(screen.getByText("Relationships")).toBeTruthy();
    expect(screen.getByText("composes")).toBeTruthy();
  });

  it("selecting an impl shows its code + role in the inspector", () => {
    render(<AlgorithmsWorkspace />);
    fireEvent.click(screen.getAllByText("merge_sort (Rust)")[0]);
    expect(screen.getByText((c) => c.includes("merge(&left, &right)"))).toBeTruthy();
    expect(screen.getByText("algorithm")).toBeTruthy(); // the role chip
  });

  it("an algorithm impl lists the impls it builds on (#2863)", () => {
    render(<AlgorithmsWorkspace />);
    fireEvent.click(screen.getAllByText("merge_sort (Rust)")[0]);
    expect(screen.getByText("Builds on")).toBeTruthy();
    expect(screen.getAllByText("merge.rs").length).toBeGreaterThan(1); // rail + canvas + builds-on row
  });

  it("a primitive row in a folder selects the primitive (#2899)", () => {
    render(<AlgorithmsWorkspace />);
    fireEvent.click(screen.getAllByText("Iterator (Rust)")[0]);
    expect(screen.getByText("primitive")).toBeTruthy();
    expect(screen.getByText((c) => c.includes("xs.iter().map(|x| x * 2)"))).toBeTruthy();
  });
});
