import { describe, it, expect } from "vitest";
import { act, render } from "@testing-library/react";
import { useAppStore } from "./";

/**
 * Pins the per-slice selector pattern ConsoleScreen relies on (#52). A
 * whole-store read (`useAppStore()`) re-renders the consumer on every
 * mutation anywhere in the store because Zustand's shallow merge produces a
 * new top-level state object each time. Per-slice selectors compare only the
 * subscribed value by `Object.is`, so unrelated mutations stay silent.
 */
describe("useAppStore selectors vs whole-store reads", () => {
  it("subscribing per slice does not re-render on unrelated mutations", () => {
    let renderCount = 0;
    function Probe() {
      renderCount++;
      // Mirrors the per-slice pattern ConsoleScreen now uses.
      useAppStore((s) => s.tabs);
      useAppStore((s) => s.activeTabIdx);
      return null;
    }
    render(<Probe />);
    const initial = renderCount;

    // Flipping a field this probe doesn't subscribe to: the shallow-merged
    // state object is new, but `tabs` and `activeTabIdx` reference unchanged.
    act(() => { useAppStore.setState({ terminalFontSize: 16 }); });
    expect(renderCount).toBe(initial);

    // Flipping a subscribed slice DOES re-render — the selector pattern still
    // tracks the slices it claims to.
    act(() => { useAppStore.setState({ activeTabIdx: 1 }); });
    expect(renderCount).toBe(initial + 1);
  });

  it("regression guard: a whole-store read DOES re-render on unrelated mutations", () => {
    let renderCount = 0;
    function Probe() {
      renderCount++;
      // The pre-refactor anti-pattern: read the entire store.
      useAppStore();
      return null;
    }
    render(<Probe />);
    const initial = renderCount;

    // The exact behavior the ConsoleScreen refactor eliminates: an unrelated
    // store mutation forces a re-render of every whole-store consumer.
    act(() => { useAppStore.setState({ terminalFontSize: 18 }); });
    expect(renderCount).toBeGreaterThan(initial);
  });
});
