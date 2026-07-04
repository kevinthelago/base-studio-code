// SplitView (#2197 slice 2) — the two-pane split page skeleton: a flexing primary beside/above a
// fixed-size, drag-resizable secondary, with an optional toolbar. The secondary is the RESIZED pane
// (it sits after the splitter, so it grows as the pointer moves back toward the primary — inverted).
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SplitView } from "./SplitView";

describe("SplitView (#2197)", () => {
  it("renders the primary, secondary, and toolbar slots", () => {
    render(<SplitView toolbar={<span>TOOLBAR</span>} primary={<span>PRIMARY</span>} secondary={<span>SECONDARY</span>} />);
    expect(screen.getByText("TOOLBAR")).toBeInTheDocument();
    expect(screen.getByText("PRIMARY")).toBeInTheDocument();
    expect(screen.getByText("SECONDARY")).toBeInTheDocument();
  });

  it("omits the toolbar when not provided", () => {
    render(<SplitView primary={<span>PRIMARY</span>} secondary={<span>SECONDARY</span>} />);
    expect(screen.queryByText("TOOLBAR")).toBeNull();
    expect(screen.getByText("PRIMARY")).toBeInTheDocument();
  });

  it("gives the secondary the requested fixed size (width when horizontal)", () => {
    render(<SplitView secondarySize={300} primary={<span>PRIMARY</span>} secondary={<span>SECONDARY</span>} />);
    const secBox = screen.getByText("SECONDARY").parentElement as HTMLElement;
    expect(secBox.style.width).toBe("300px");
    expect(secBox.style.flex).toContain("300px");
  });

  it("sizes the secondary by height when vertical", () => {
    render(<SplitView orientation="vertical" secondarySize={240} primary={<span>PRIMARY</span>} secondary={<span>SECONDARY</span>} />);
    const secBox = screen.getByText("SECONDARY").parentElement as HTMLElement;
    expect(secBox.style.height).toBe("240px");
    expect(secBox.style.width).toBe("");
  });

  it("uses the horizontal splitter by default and the vertical one when stacked", () => {
    const h = render(<SplitView primary={<span>P</span>} secondary={<span>S</span>} />);
    expect(h.container.querySelector(".resize-x")).not.toBeNull();
    expect(h.container.querySelector(".resize-y")).toBeNull();
    const v = render(<SplitView orientation="vertical" primary={<span>P</span>} secondary={<span>S</span>} />);
    expect(v.container.querySelector(".resize-y")).not.toBeNull();
  });

  it("has no splitter when resizable is off", () => {
    const { container } = render(
      <SplitView resizable={false} primary={<span>PRIMARY</span>} secondary={<span>SECONDARY</span>} />,
    );
    expect(container.querySelector(".resize-x")).toBeNull();
  });

  it("omits the primary divider border when divider is off", () => {
    render(<SplitView divider={false} primary={<span>PRIMARY</span>} secondary={<span>SECONDARY</span>} />);
    const primBox = screen.getByText("PRIMARY").parentElement as HTMLElement;
    expect(primBox.style.borderRight).toBe("");
  });

  it("merges a root style escape hatch (e.g. a top divider seam)", () => {
    const { container } = render(
      <SplitView style={{ borderTop: "1px solid var(--border-soft)" }}
        primary={<span>PRIMARY</span>} secondary={<span>SECONDARY</span>} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.borderTop).toBe("1px solid var(--border-soft)");
    // The template's own frame styles survive the merge.
    expect(root.style.overflow).toBe("hidden");
  });
});

describe("SplitView — resizable secondary (inverted drag)", () => {
  it("grows the secondary as the pointer moves toward the primary, clamped to max", () => {
    const { container } = render(
      <SplitView secondarySize={300} secondaryMin={200} secondaryMax={500}
        primary={<span>PRIMARY</span>} secondary={<span>SECONDARY</span>} />,
    );
    const handle = container.querySelector(".resize-x") as HTMLElement;
    const secBox = screen.getByText("SECONDARY").parentElement as HTMLElement;

    // Pointer moves LEFT (−40) → the trailing secondary grows by 40 (invert).
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: -40, pointerId: 1 });
    expect(secBox.style.width).toBe("340px");

    // Past the max is clamped.
    fireEvent.pointerMove(handle, { clientX: -999, pointerId: 1 });
    expect(secBox.style.width).toBe("500px");
    fireEvent.pointerUp(handle, { clientX: -999, pointerId: 1 });
  });
});
