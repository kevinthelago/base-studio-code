// Panning must not re-render the graph (#4140).
//
// The drag used to `setView` on every mousemove, so each pan frame reconciled the whole graph subtree —
// 248 nodes + 799 edges per EVENT, and mouse events outpace frames. These assert the RENDER COUNT and
// the DOM transform, because a version that produced the right final position via a render per event
// would pass a position-only test and fix nothing.
import { describe, it, expect } from "vitest";
import { useRef, useState } from "react";
import { render, fireEvent, act } from "@testing-library/react";
import { useGraphViewport, viewTransform, PANNING_CLASS } from "./useGraphViewport";

/** A minimal graph: the viewport div + the world layer, wired exactly as GraphCanvas wires them. */
function Harness({ onRender }: { onRender: () => void }) {
  const vp = useGraphViewport({ w: 2000, h: 2000 });
  const [, bump] = useState(0);
  const bumpRef = useRef(bump);
  bumpRef.current = bump;
  onRender();
  return (
    <div>
      <div data-testid="vp" ref={vp.setVp} onMouseDown={vp.onCanvasDown} style={{ width: 800, height: 600 }}>
        <div data-testid="world" ref={vp.setWorld} style={{ ...vp.worldTransform }} />
      </div>
      {/* Lets a test force an UNRELATED re-render mid-drag — the stale-state trap. */}
      <button data-testid="rerender" onClick={() => bumpRef.current((n) => n + 1)}>x</button>
    </div>
  );
}

const drag = (vp: HTMLElement, moves: Array<[number, number]>) => {
  fireEvent.mouseDown(vp, { clientX: 0, clientY: 0 });
  for (const [x, y] of moves) fireEvent.mouseMove(window, { clientX: x, clientY: y });
};

describe("pan is decoupled from React (#4140)", () => {
  it("renders ZERO times across a drag, then exactly once on mouseup", () => {
    let renders = 0;
    const { getByTestId } = render(<Harness onRender={() => { renders += 1; }} />);
    const before = renders;
    drag(getByTestId("vp"), [[10, 5], [20, 10], [30, 15], [40, 20], [50, 25]]);
    expect(renders - before).toBe(0); // the pre-#4140 path was one render PER move
    act(() => { fireEvent.mouseUp(window); });
    expect(renders - before).toBe(1); // the single commit
  });

  it("paints every intermediate position to the DOM even without rendering", () => {
    const { getByTestId } = render(<Harness onRender={() => {}} />);
    const world = getByTestId("world");
    drag(getByTestId("vp"), [[10, 5]]);
    expect(world.style.transform).toBe(viewTransform({ tx: 10, ty: 5, scale: 1 }));
    fireEvent.mouseMove(window, { clientX: 60, clientY: 30 });
    expect(world.style.transform).toBe(viewTransform({ tx: 60, ty: 30, scale: 1 }));
  });

  it("survives an unrelated re-render MID-drag — the stale-state trap", () => {
    // React's committed `view` is still the pre-drag origin here. If the world layer took its transform
    // from that state, this render would snap the graph back under the user's cursor.
    const { getByTestId } = render(<Harness onRender={() => {}} />);
    const world = getByTestId("world");
    drag(getByTestId("vp"), [[80, 40]]);
    act(() => { fireEvent.click(getByTestId("rerender")); });
    expect(world.style.transform).toBe(viewTransform({ tx: 80, ty: 40, scale: 1 }));
  });

  it("commits the FINAL position to React, so consumers keyed on `view` converge", () => {
    const { getByTestId } = render(<Harness onRender={() => {}} />);
    const world = getByTestId("world");
    drag(getByTestId("vp"), [[15, 25], [35, 45]]);
    act(() => { fireEvent.mouseUp(window); });
    // A post-commit re-render must keep the dragged position, not revert it.
    act(() => { fireEvent.click(getByTestId("rerender")); });
    expect(world.style.transform).toBe(viewTransform({ tx: 35, ty: 45, scale: 1 }));
  });

  it("marks the viewport as panning for the whole gesture, so the cursor covers the subtree (#4144)", () => {
    // CSS `cursor` resolves per element, so a node's own `cursor: pointer` wins under the pointer and a
    // drag across nodes flickered grabbing → pointer → grabbing. The class carries a `*` rule; what
    // matters here is that it is present for exactly the duration of the gesture.
    const { getByTestId } = render(<Harness onRender={() => {}} />);
    const vp = getByTestId("vp");
    expect(vp.classList.contains(PANNING_CLASS)).toBe(false);
    fireEvent.mouseDown(vp, { clientX: 0, clientY: 0 });
    expect(vp.classList.contains(PANNING_CLASS)).toBe(true);
    fireEvent.mouseMove(window, { clientX: 40, clientY: 20 });
    expect(vp.classList.contains(PANNING_CLASS)).toBe(true); // still panning mid-gesture
    act(() => { fireEvent.mouseUp(window); });
    expect(vp.classList.contains(PANNING_CLASS)).toBe(false);
  });

  it("clears the panning class even when the drag ends outside the viewport", () => {
    // mouseup is bound to the WINDOW, so releasing off-canvas must still end the gesture — otherwise the
    // whole app would be stuck showing the grabbing cursor.
    const { getByTestId } = render(<Harness onRender={() => {}} />);
    const vp = getByTestId("vp");
    fireEvent.mouseDown(vp, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(window, { clientX: 5000, clientY: 5000 });
    act(() => { fireEvent.mouseUp(document.body); });
    expect(vp.classList.contains(PANNING_CLASS)).toBe(false);
  });

  it("still discriminates a click from a drag (`dragMoved`)", () => {
    // Below the 4px threshold nothing counts as a pan, so the click that follows still selects a node.
    const { getByTestId } = render(<Harness onRender={() => {}} />);
    const world = getByTestId("world");
    drag(getByTestId("vp"), [[1, 1]]);
    act(() => { fireEvent.mouseUp(window); });
    expect(world.style.transform).toBe(viewTransform({ tx: 1, ty: 1, scale: 1 }));
  });
});
