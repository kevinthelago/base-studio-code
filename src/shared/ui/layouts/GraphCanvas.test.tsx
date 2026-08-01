// GraphCanvas (#2208, epic #2197 slice 2) — the pan/zoom graph page template: toolbar + rail + canvas
// (world layer) + inspector + fixed overlays, plus the shared ZoomControls cluster.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GraphCanvas, ZoomControls } from "./GraphCanvas";
import type { GraphViewport } from "./useGraphViewport";

function fakeVp(over: Partial<GraphViewport> = {}): GraphViewport {
  return {
    view: { tx: 0, ty: 0, scale: 1 },
    setVp: () => {},
    setWorld: () => {},
    onCanvasDown: () => {},
    fit: () => {},
    centerOn: () => {},
    zoomBy: () => {},
    zoomTo: () => {},
    zoomToCentered: () => {},
    panBy: () => {},
    zoomAtClient: () => {},
    dragMoved: { current: false },
    worldTransform: { transform: "translate(0px,0px) scale(1)" },
    ...over,
  };
}

describe("GraphCanvas (#2208)", () => {
  it("renders the toolbar, rail, world children, inspector, and overlays", () => {
    render(
      <GraphCanvas
        vp={fakeVp()} world={{ w: 800, h: 600 }}
        toolbar={<span>TOOLBAR</span>}
        rail={<span>RAIL</span>}
        inspector={<span>INSPECTOR</span>}
        overlays={<span>OVERLAY</span>}
      >
        <span>WORLD</span>
      </GraphCanvas>,
    );
    expect(screen.getByText("TOOLBAR")).toBeInTheDocument();
    expect(screen.getByText("RAIL")).toBeInTheDocument();
    expect(screen.getByText("WORLD")).toBeInTheDocument();
    expect(screen.getByText("INSPECTOR")).toBeInTheDocument();
    expect(screen.getByText("OVERLAY")).toBeInTheDocument();
  });

  it("sizes the world layer to the world and applies the viewport transform", () => {
    render(
      <GraphCanvas vp={fakeVp()} world={{ w: 800, h: 600 }} toolbar={null}>
        <span>WORLD</span>
      </GraphCanvas>,
    );
    const worldLayer = screen.getByText("WORLD").parentElement as HTMLElement;
    expect(worldLayer.style.width).toBe("800px");
    expect(worldLayer.style.height).toBe("600px");
    expect(worldLayer.style.transform).toBe("translate(0px,0px) scale(1)");
    expect(worldLayer.style.userSelect).toBe("none"); // no text-selecting nodes/edges on drag (#2527)
  });

  it("omits the rail and inspector when not provided", () => {
    render(
      <GraphCanvas vp={fakeVp()} world={{ w: 10, h: 10 }} toolbar={null}>
        <span>WORLD</span>
      </GraphCanvas>,
    );
    expect(screen.queryByText("RAIL")).toBeNull();
    expect(screen.queryByText("INSPECTOR")).toBeNull();
  });

  it("renders the dock strip below the canvas when provided, and nothing when absent", () => {
    const { rerender } = render(
      <GraphCanvas vp={fakeVp()} world={{ w: 10, h: 10 }} toolbar={null}>
        <span>WORLD</span>
      </GraphCanvas>,
    );
    expect(screen.queryByText("DOCK")).toBeNull();
    rerender(
      <GraphCanvas vp={fakeVp()} world={{ w: 10, h: 10 }} toolbar={null} dock={<span>DOCK</span>}>
        <span>WORLD</span>
      </GraphCanvas>,
    );
    expect(screen.getByText("DOCK")).toBeInTheDocument();
  });

  it("renders drag-resize splitters when the rail/inspector are resizable", () => {
    const { container } = render(
      <GraphCanvas
        vp={fakeVp()} world={{ w: 10, h: 10 }} toolbar={null}
        rail={<span>RAIL</span>} inspector={<span>INSPECTOR</span>}
        railResizable inspectorResizable
      >
        <span>WORLD</span>
      </GraphCanvas>,
    );
    // one splitter after the rail + one before the inspector
    expect(container.querySelectorAll(".resize-x")).toHaveLength(2);
  });

  it("has no splitters when the sides are fixed-width (default)", () => {
    const { container } = render(
      <GraphCanvas vp={fakeVp()} world={{ w: 10, h: 10 }} toolbar={null} rail={<span>RAIL</span>}>
        <span>WORLD</span>
      </GraphCanvas>,
    );
    expect(container.querySelectorAll(".resize-x")).toHaveLength(0);
  });

  it("draws the infinite grid backdrop only when `grid` is set", () => {
    const { container, rerender } = render(
      <GraphCanvas vp={fakeVp()} world={{ w: 10, h: 10 }} toolbar={null}>
        <span>WORLD</span>
      </GraphCanvas>,
    );
    const hasGrid = () => [...container.querySelectorAll("div")].find((d) => d.style.backgroundImage.includes("radial-gradient"));
    // No grid by default.
    expect(hasGrid()).toBeUndefined();
    // With grid on, the backdrop lives on the VIEWPORT so it fills it and never stops at the world box.
    // It no longer tracks pan/zoom (#4142) — see the static-grid block below for that contract.
    rerender(
      <GraphCanvas vp={fakeVp({ view: { tx: 40, ty: -25, scale: 2 } })} world={{ w: 10, h: 10 }} toolbar={null} grid gridSize={24}>
        <span>WORLD</span>
      </GraphCanvas>,
    );
    expect(hasGrid()).toBeTruthy();
  });

  // #2230 — clicking the empty backdrop clears the selection.
  it("fires onBackgroundClick on a genuine backdrop click, but not on a node press or after a pan", () => {
    const onBackgroundClick = vi.fn();
    const vp = fakeVp();
    render(
      <GraphCanvas vp={vp} world={{ w: 10, h: 10 }} toolbar={null} onBackgroundClick={onBackgroundClick}>
        <span>WORLD</span>
        <span data-node="n1">NODE</span>
      </GraphCanvas>,
    );
    // A click on empty world content (not a [data-node]) → fires.
    fireEvent.click(screen.getByText("WORLD"));
    expect(onBackgroundClick).toHaveBeenCalledTimes(1);

    // A click on a [data-node] element (a node press) → ignored.
    fireEvent.click(screen.getByText("NODE"));
    expect(onBackgroundClick).toHaveBeenCalledTimes(1);

    // The click that ends a pan-drag (dragMoved) → ignored.
    vp.dragMoved.current = true;
    fireEvent.click(screen.getByText("WORLD"));
    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
  });
});

describe("ZoomControls (#2208)", () => {
  it("shows the current zoom as a percent", () => {
    render(<ZoomControls vp={fakeVp({ view: { tx: 0, ty: 0, scale: 0.62 } })} />);
    expect(screen.getByText("62%")).toBeInTheDocument();
  });

  it("zooms in/out by the step factor", () => {
    const zoomBy = vi.fn();
    render(<ZoomControls vp={fakeVp({ zoomBy })} step={1.2} />);
    fireEvent.click(screen.getByLabelText("zoom in"));
    fireEvent.click(screen.getByLabelText("zoom out"));
    expect(zoomBy).toHaveBeenNthCalledWith(1, 1.2);
    expect(zoomBy).toHaveBeenNthCalledWith(2, 1 / 1.2);
  });
});

describe("the background grid is static (#4142)", () => {
  // #4140 stopped the pan from committing per mousemove, so a grid keyed on `view` froze mid-drag and
  // JUMPED on release. These pin the decoupling: the grid's style must not vary with the viewport.
  const gridOf = (container: HTMLElement) =>
    [...container.querySelectorAll("div")].find((d) => d.style.backgroundImage.includes("radial-gradient"));

  it("renders identically whatever the pan and zoom are", () => {
    const at = (view: { tx: number; ty: number; scale: number }) => {
      const { container } = render(
        <GraphCanvas vp={fakeVp({ view })} world={{ w: 500, h: 500 }} toolbar={null} grid gridSize={22}>
          <div />
        </GraphCanvas>,
      );
      const g = gridOf(container)!;
      return { size: g.style.backgroundSize, pos: g.style.backgroundPosition };
    };
    const origin = at({ tx: 0, ty: 0, scale: 1 });
    expect(origin.size).toBe("22px 22px");
    // Panned far and zoomed right in — the grid must not budge or rescale.
    expect(at({ tx: -940, ty: 380, scale: 2.4 })).toEqual(origin);
    expect(at({ tx: 77, ty: -12, scale: 0.3 })).toEqual(origin);
  });

  it("still honours gridSize, so the decoupling did not hard-code the spacing", () => {
    const { container } = render(
      <GraphCanvas vp={fakeVp()} world={{ w: 500, h: 500 }} toolbar={null} grid gridSize={40}>
        <div />
      </GraphCanvas>,
    );
    expect(gridOf(container)!.style.backgroundSize).toBe("40px 40px");
  });

  it("omits the grid entirely when the page does not ask for one", () => {
    const { container } = render(
      <GraphCanvas vp={fakeVp()} world={{ w: 500, h: 500 }} toolbar={null}><div /></GraphCanvas>,
    );
    expect(gridOf(container)).toBeUndefined();
  });
});
