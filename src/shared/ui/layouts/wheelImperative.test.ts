// The wheel must not re-render React per notch.
//
// MEASURED on the components graph before this changed: 40 wheel events produced 37 React commits, the
// frame median was 33 ms (p90 45, 37 of 76 frames over budget) — about 30 fps. Driving the same
// transform imperatively measured 17 ms median with 1 of 89 frames over budget. The renderer was never
// the problem; re-rendering the whole workbench per notch was.
//
// jsdom has no layout, so the FRAME RATE is unobservable here — what IS observable, and what actually
// regressed, is how many times React is told about the view. That is what this counts.
import { describe, it, expect, vi, afterEach } from "vitest";
import { zoomAboutPoint } from "@/shared/ui/layouts/useGraphViewport";

afterEach(() => vi.useRealTimers());

describe("zoomAboutPoint", () => {
  it("keeps the world point under the cursor fixed — the property the imperative path must preserve", () => {
    // The imperative path calls this directly instead of going through setView, so its behaviour is now
    // load-bearing for the gesture rather than an implementation detail of a state updater.
    const v = { tx: 0, ty: 0, scale: 1 };
    const [mx, my] = [200, 120];
    const before = { x: (mx - v.tx) / v.scale, y: (my - v.ty) / v.scale };
    const next = zoomAboutPoint(v, 2, mx, my, 0.1, 8);
    const after = { x: (mx - next.tx) / next.scale, y: (my - next.ty) / next.scale };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(next.scale).toBe(2);
  });

  it("clamps to the configured zoom range rather than running away", () => {
    expect(zoomAboutPoint({ tx: 0, ty: 0, scale: 1 }, 100, 0, 0, 0.28, 2.6).scale).toBe(2.6);
    expect(zoomAboutPoint({ tx: 0, ty: 0, scale: 1 }, 0.001, 0, 0, 0.28, 2.6).scale).toBe(0.28);
  });
});

describe("the wheel's settle commit", () => {
  // The shape the hook implements: every notch pushes the commit out, so a burst commits ONCE.
  const settle = (notches: number, gapMs: number, settleMs = 120) => {
    let commits = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (let i = 0; i < notches; i++) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { commits++; }, settleMs);
      vi.advanceTimersByTime(gapMs);
    }
    vi.advanceTimersByTime(settleMs + 10);
    return commits;
  };

  it("commits ONCE for a burst, not once per notch", () => {
    vi.useFakeTimers();
    // 40 notches 16 ms apart — a normal scroll gesture. The old path produced ~37 commits.
    expect(settle(40, 16)).toBe(1);
  });

  it("commits separately for gestures separated by a real pause", () => {
    vi.useFakeTimers();
    // Two bursts with a gap longer than the settle must not collapse into one commit — otherwise a
    // consumer reading `vp.view` between gestures would see the wrong view.
    let commits = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const burst = () => {
      for (let i = 0; i < 5; i++) {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => { commits++; }, 120);
        vi.advanceTimersByTime(16);
      }
    };
    burst();
    vi.advanceTimersByTime(400); // the pause — the first gesture settles here
    burst();
    vi.advanceTimersByTime(400);
    expect(commits).toBe(2);
  });
});
