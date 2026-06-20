import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { clampSize, useDragResize } from "./useDragResize";

describe("clampSize", () => {
  it("returns the value when within range", () => {
    expect(clampSize(200, 100, 300)).toBe(200);
  });
  it("clamps to the lower bound", () => {
    expect(clampSize(50, 100, 300)).toBe(100);
  });
  it("clamps to the upper bound", () => {
    expect(clampSize(999, 100, 300)).toBe(300);
  });
});

// Minimal pointer-event stub with the capture methods the hook calls.
function pointerEvent(coords: { clientX?: number; clientY?: number }) {
  return {
    pointerId: 1,
    clientX: coords.clientX ?? 0,
    clientY: coords.clientY ?? 0,
    preventDefault() {},
    currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
  } as unknown as React.PointerEvent;
}

describe("useDragResize", () => {
  it("starts clamped to the initial size", () => {
    const { result } = renderHook(() => useDragResize({ initial: 999, min: 100, max: 300, axis: "x" }));
    expect(result.current.size).toBe(300);
  });

  it("resizes along the x axis and clamps to bounds", () => {
    const { result } = renderHook(() => useDragResize({ initial: 200, min: 100, max: 300, axis: "x" }));

    act(() => result.current.handleProps.onPointerDown(pointerEvent({ clientX: 0 })));
    act(() => result.current.handleProps.onPointerMove(pointerEvent({ clientX: 40 })));
    expect(result.current.size).toBe(240);

    // Beyond the max is clamped.
    act(() => result.current.handleProps.onPointerMove(pointerEvent({ clientX: 500 })));
    expect(result.current.size).toBe(300);

    // After pointer-up, further moves are ignored.
    act(() => result.current.handleProps.onPointerUp(pointerEvent({ clientX: 500 })));
    act(() => result.current.handleProps.onPointerMove(pointerEvent({ clientX: 0 })));
    expect(result.current.size).toBe(300);
  });

  it("inverts the delta for an after-the-handle panel on the y axis", () => {
    const { result } = renderHook(() =>
      useDragResize({ initial: 200, min: 50, max: 400, axis: "y", invert: true }),
    );
    act(() => result.current.handleProps.onPointerDown(pointerEvent({ clientY: 100 })));
    // Pointer moves DOWN (clientY +60); inverted → panel shrinks by 60.
    act(() => result.current.handleProps.onPointerMove(pointerEvent({ clientY: 160 })));
    expect(result.current.size).toBe(140);
  });
});
