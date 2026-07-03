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
    onCanvasDown: () => {},
    fit: () => {},
    zoomBy: () => {},
    zoomTo: () => {},
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
