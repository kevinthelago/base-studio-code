// useGraphPage (#2719) — the shared "create a viewport + rAF-fit on a stable key" composition. We
// mock the underlying viewport so `fit` is a spy, then assert the hook fits on mount and on each
// key change but NOT when only the world object churns (the polled-model trap the doc warns about).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { fitSpy } = vi.hoisted(() => ({ fitSpy: vi.fn() }));
vi.mock("./useGraphViewport", async (orig) => {
  const actual = await orig<typeof import("./useGraphViewport")>();
  return {
    ...actual,
    useGraphViewport: () => ({
      view: { tx: 0, ty: 0, scale: 1 },
      setVp: () => {}, onCanvasDown: () => {}, fit: fitSpy, centerOn: () => {},
      zoomBy: () => {}, zoomTo: () => {}, zoomToCentered: () => {}, panBy: () => {}, zoomAtClient: () => {},
      dragMoved: { current: false }, worldTransform: {},
    }),
  };
});

import { useGraphPage } from "./useGraphPage";

const flushRaf = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });

describe("useGraphPage (#2719)", () => {
  beforeEach(() => fitSpy.mockClear());

  it("fits once on mount (deferred to a frame)", async () => {
    renderHook(({ k }) => useGraphPage({ w: 100, h: 100 }, [k]), { initialProps: { k: "a" } });
    expect(fitSpy).not.toHaveBeenCalled(); // deferred, not synchronous
    await flushRaf();
    expect(fitSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fits when the key changes but NOT when only the world churns", async () => {
    const { rerender } = renderHook(
      ({ k, world }: { k: string; world: { w: number; h: number } }) => useGraphPage(world, [k]),
      { initialProps: { k: "a", world: { w: 100, h: 100 } } },
    );
    await flushRaf();
    expect(fitSpy).toHaveBeenCalledTimes(1); // mount

    // A fresh world reference with the SAME key must not re-fit (the polled-model trap).
    rerender({ k: "a", world: { w: 100, h: 100 } });
    await flushRaf();
    expect(fitSpy).toHaveBeenCalledTimes(1);

    // Changing the key re-fits.
    rerender({ k: "b", world: { w: 100, h: 100 } });
    await flushRaf();
    expect(fitSpy).toHaveBeenCalledTimes(2);
  });
});
