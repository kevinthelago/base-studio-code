// The Algorithms Workspace (#2761 · #2770 impl tier · #2773 rail) — render smoke test + the
// select→inspector interaction. NB: node names now appear in BOTH the rail and the canvas (and a
// selected concept also in the inspector), and complexities like "O(n log n)" repeat across cards —
// so use getAllByText for anything that isn't inspector-unique.
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
  it("renders the graph, the rail, and the empty-inspector legend", () => {
    render(<AlgorithmsWorkspace />);
    expect(screen.getByText(/nodes ·/)).toBeTruthy();          // read-only toolbar count "N nodes · M relationships" (#2785)
    // "Concepts" is a node KIND now (the rail header is "Nodes", #2785) — it shows as a rail kind-group
    // header and in the inspector's Kinds legend, so it still repeats.
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

  it("the language-kit selector switches the inspector to the chosen language's impl (#2863)", () => {
    render(<AlgorithmsWorkspace />);
    // Both seeded kits are offered as a selector.
    expect(screen.getByText("TypeScript")).toBeTruthy();
    expect(screen.getByText("Rust")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Merge Sort")[0]);
    // Default (TypeScript) shows the TS impl…
    expect(screen.getByText((c) => c.includes("return merge(left, right, cmp);"))).toBeTruthy();
    // …switching to Rust shows the Rust impl — unreachable before #2863's language selector.
    fireEvent.click(screen.getByText("Rust"));
    expect(screen.getByText((c) => c.includes("merge(&left, &right)"))).toBeTruthy();
    expect(screen.getByText("merge.rs")).toBeTruthy();
  });
});
