import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePreviewStateCycle, PREVIEW_CYCLE_MS } from "./usePreviewStateCycle";
import type { ComponentRecord, PropSpec } from "./model";

const prop = (name: string, type: string): PropSpec => ({ name, type, req: false, desc: "" });
const base: ComponentRecord = {
  id: "c", name: "C", kitId: "k", role: "primitive", version: "1.0.0", used: 0,
  tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [], src: "x.tsx", srcText: "",
};
const mk = (id: string, props: PropSpec[]): ComponentRecord => ({ ...base, id, props });

describe("usePreviewStateCycle (#3555)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("advances through the cyclable states on the timer, and wraps", () => {
    const comp = mk("full", [prop("loading", "boolean"), prop("rows", "Row[]"), prop("error", "string")]);
    const { result } = renderHook(() => usePreviewStateCycle(comp, false));
    expect(result.current).toBe("loading"); // cycle is loading → loaded → error (empty dropped)
    act(() => vi.advanceTimersByTime(PREVIEW_CYCLE_MS));
    expect(result.current).toBe("loaded");
    act(() => vi.advanceTimersByTime(PREVIEW_CYCLE_MS));
    expect(result.current).toBe("error");
    act(() => vi.advanceTimersByTime(PREVIEW_CYCLE_MS));
    expect(result.current).toBe("loading"); // wraps
  });

  it("a single-state (plain) component never advances", () => {
    const comp = mk("btn", [prop("label", "string")]);
    const { result } = renderHook(() => usePreviewStateCycle(comp, false));
    expect(result.current).toBe("loaded");
    act(() => vi.advanceTimersByTime(PREVIEW_CYCLE_MS * 4));
    expect(result.current).toBe("loaded");
  });

  it("holds still while paused (e.g. hovered)", () => {
    const comp = mk("full", [prop("loading", "boolean"), prop("error", "string")]);
    const { result } = renderHook(() => usePreviewStateCycle(comp, true));
    expect(result.current).toBe("loading");
    act(() => vi.advanceTimersByTime(PREVIEW_CYCLE_MS * 3));
    expect(result.current).toBe("loading"); // no advance while paused
  });
});
