// The Algorithms Workspace (#2761 · #2863 per-kit graph) — render smoke test + the select→inspector
// interaction. The LANGUAGE IS A TAB (`technology-tabs-for-components-and-algorithms`); the LEFT PANE is
// that language's folder tree, and the CENTER is its graph. Every impl name appears in BOTH the rail and
// the canvas, so use getAllByText for anything that isn't inspector-unique (impl code, the role chip).
//
// The seed is TypeScript-first (`TECHS` order), so a Rust case has to select the Rust tab. That is the
// point of the change rather than an inconvenience: reaching a Rust impl is now one deliberate act
// instead of scrolling past every other language's folder.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlgorithmsWorkspace } from "@/features/algorithms/AlgorithmsWorkspace";

// The page docks the librarian session (#2787), which mounts an xterm terminal — stub xterm (it can't
// initialize in jsdom) + the layout globals useScreenSession needs, so rendering the page doesn't crash.
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80; rows = 24; options: Record<string, unknown> = {};
    loadAddon = vi.fn(); open = vi.fn(); write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() })); focus = vi.fn(); dispose = vi.fn();
    attachCustomKeyEventHandler = vi.fn(); getSelection = vi.fn(() => "");
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
  /** Select a language TAB by its label. */
  const openTech = (label: string) => fireEvent.click(screen.getByText(label));

  it("offers a tab per language and shows only that language's impls", () => {
    render(<AlgorithmsWorkspace />);
    // Both languages are TABS now — the level that used to be a rail folder head.
    expect(screen.getByText("Rust")).toBeTruthy();
    expect(screen.getByText("TypeScript")).toBeTruthy();
    // TypeScript is the default tab, so a Rust impl is NOT on screen until its tab is chosen. This is
    // the scoping the tabs buy: the rail carries one language rather than all of them at once.
    expect(screen.queryByText("merge_sort")).toBeNull();
    openTech("Rust");
    expect(screen.getAllByText("merge_sort").length).toBeGreaterThan(0);
    // The on-graph legend (not the inspector) keys the edge types present in the active kit — `composes`
    // is live (every seeded kit has one).
    expect(screen.getByText("Relationships")).toBeTruthy();
    expect(screen.getByText("composes")).toBeTruthy();
  });

  it("selecting an impl shows its code + role in the inspector", () => {
    render(<AlgorithmsWorkspace />);
    openTech("Rust");
    fireEvent.click(screen.getAllByText("merge_sort")[0]);
    expect(screen.getByText((c) => c.includes("merge(&left, &right)"))).toBeTruthy();
    expect(screen.getByText("algorithm")).toBeTruthy(); // the role chip
  });

  it("an algorithm impl lists the impls it builds on (#2863)", () => {
    render(<AlgorithmsWorkspace />);
    openTech("Rust");
    fireEvent.click(screen.getAllByText("merge_sort")[0]);
    expect(screen.getByText("Builds on")).toBeTruthy();
    expect(screen.getAllByText("merge.rs").length).toBeGreaterThan(1); // rail + canvas + builds-on row
  });

  it("a primitive node is visually marked + shows as a descriptor with its std ref (#2899/#2972/#2980)", () => {
    const { container } = render(<AlgorithmsWorkspace />);
    // Open the Rust TAB first (TypeScript is default-active), then select its primitive rail row.
    openTech("Rust");
    fireEvent.click(screen.getAllByText("Iterator")[0]);
    // The primitive node carries the distinct `algo-prim` marker (violet dashed descriptor chip, #2980).
    expect(container.querySelector('[data-impl="rust.iterator"]')?.className).toContain("algo-prim");
    expect(screen.getByText("primitive")).toBeTruthy();
    // A primitive is DESCRIBED by the language built-in it names, not re-coded (#2972) — shown on the
    // node meta AND the inspector, so the ref appears more than once.
    expect(screen.getAllByText((c) => c.includes("std::iter::Iterator")).length).toBeGreaterThan(0);
  });
});
