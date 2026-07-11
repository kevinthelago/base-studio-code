// useDockEntrance (#2905) — the dock entrance grow. The synchronous rAF stub runs the frame-count loop
// to completion in one tick, so we can assert the whole size sweep.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render } from "@testing-library/react";
import { useDockEntrance } from "./useDockEntrance";

beforeAll(() => {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

function Probe({ onSize, target }: { onSize: (n: number) => void; target: number }) {
  useDockEntrance(onSize, target);
  return null;
}

describe("useDockEntrance", () => {
  it("grows the size from a fraction of the target up to exactly the target", () => {
    const sizes: number[] = [];
    render(<Probe onSize={(n) => sizes.push(n)} target={340} />);
    // Starts small (a fraction of the target)…
    expect(sizes[0]).toBeGreaterThan(0);
    expect(sizes[0]).toBeLessThan(340);
    // …lands exactly on the resting height…
    expect(sizes[sizes.length - 1]).toBe(340);
    // …and never shrinks along the way (an ease-out grow).
    expect(sizes.every((s, i) => i === 0 || s >= sizes[i - 1])).toBe(true);
  });

  it("jumps straight to the resting height under reduced motion", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    const sizes: number[] = [];
    render(<Probe onSize={(n) => sizes.push(n)} target={300} />);
    expect(sizes).toEqual([300]); // no grow — one set, straight to the target
    vi.stubGlobal("matchMedia", undefined); // leave rAF stub intact for any later tests
  });
});
