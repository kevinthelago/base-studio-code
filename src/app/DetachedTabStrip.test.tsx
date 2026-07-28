// The detached window's strip + the POINTER dock-back gesture (#3919/#3925/#3927).
//
// The gesture moved off HTML5 drag-and-drop deliberately: an HTML5 drag is owned by its source webview,
// so over another window the OS paints `no-drop` and no `drop` ever arrives. These pin the pointer
// mechanics — the release POSITION decides, not a drag event that stops firing when the cursor leaves.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const emitDockBack = vi.fn().mockResolvedValue(undefined);
const close = vi.fn().mockResolvedValue(undefined);
const outerPosition = vi.fn().mockResolvedValue({ x: 100, y: 100 });
const outerSize = vi.fn().mockResolvedValue({ width: 800, height: 600 });
vi.mock("@/shared/lib/core/dockBack", () => ({
  emitDockBack: (p: unknown) => emitDockBack(p),
  DOCK_BACK_EVENT: "bsc://dock-back",
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close, outerPosition, outerSize }),
}));

import { DetachedTabStrip, releasedOutside } from "./DetachedTabStrip";

beforeEach(() => { emitDockBack.mockClear(); close.mockClear(); });

/** Drain the microtask queue so the async window-rect fetch has settled. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Press the tab, move to a screen point, release there. */
async function dragTo(container: HTMLElement, to: { screenX: number; screenY: number }) {
  const tab = container.querySelector("[data-tab]")!;
  const bar = container.querySelector(".detached-bar")!;
  fireEvent.pointerDown(tab, { pointerId: 1, screenX: 200, screenY: 120, clientX: 40, clientY: 16 });
  await flush(); // the rect fetch is async (Promise.all + .then) — one microtask is not enough
  fireEvent.pointerMove(bar, { pointerId: 1, ...to, clientX: 40, clientY: 16 });
  fireEvent.pointerUp(bar, { pointerId: 1, ...to, clientX: 40, clientY: 16 });
}

describe("releasedOutside (#3927)", () => {
  const r = { x: 100, y: 100, w: 800, h: 600 };
  it("is false inside the window's screen rect", () => {
    expect(releasedOutside({ screenX: 400, screenY: 300 }, r)).toBe(false);
    expect(releasedOutside({ screenX: 100, screenY: 100 }, r)).toBe(false); // the edge counts as inside
  });
  it("is true past any edge", () => {
    expect(releasedOutside({ screenX: 50, screenY: 300 }, r)).toBe(true);
    expect(releasedOutside({ screenX: 400, screenY: 50 }, r)).toBe(true);
    expect(releasedOutside({ screenX: 950, screenY: 300 }, r)).toBe(true);
    expect(releasedOutside({ screenX: 400, screenY: 750 }, r)).toBe(true);
  });
  it("treats an UNKNOWN rect as outside, so a real drag still docks back", () => {
    expect(releasedOutside({ screenX: 400, screenY: 300 }, null)).toBe(true);
  });
});

describe("DetachedTabStrip (#3919)", () => {
  it("presents the page's tab, so there is something to grab", () => {
    render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    expect(screen.getAllByText("Repos").length).toBeGreaterThan(0);
  });

  it("carries the window controls in the SAME bar — no separate titlebar, no breadcrumb", () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    expect(container.querySelector(".tabstrip.chrome-bar"), "the one-bar chrome").toBeTruthy();
    expect(container.querySelector(".tabstrip .tabstrip-trailing"), "controls inside the strip").toBeTruthy();
    expect(container.querySelector(".titlebar"), "no second bar").toBeNull();
    expect(screen.queryByText(/github · Repos/), "no breadcrumb").toBeNull();
  });

  it("does NOT make the tab HTML5-draggable — that mechanism paints the no-drop cursor (#3927)", () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    const tab = container.querySelector("[data-tab]") as HTMLElement;
    expect(tab.getAttribute("draggable")).not.toBe("true");
  });

  it("docks back when released OUTSIDE the window", async () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    await dragTo(container, { screenX: 1500, screenY: 400 }); // past the right edge (100+800)
    expect(emitDockBack).toHaveBeenCalledWith({ page: "github", section: "repos" });
  });

  it("does NOT dock back when released INSIDE the window — a cancelled gesture", async () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    await dragTo(container, { screenX: 400, screenY: 300 });
    expect(emitDockBack).not.toHaveBeenCalled();
  });

  it("treats a press without movement as a CLICK, not a drag", async () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    await dragTo(container, { screenX: 202, screenY: 121 }); // 3px total — under the threshold
    expect(emitDockBack).not.toHaveBeenCalled();
  });

  it("ignores a press that starts on the window controls, not the tab", async () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    const bar = container.querySelector(".detached-bar")!;
    const controls = container.querySelector(".tabstrip-trailing")!;
    fireEvent.pointerDown(controls, { pointerId: 1, screenX: 200, screenY: 120 });
    await flush();
    fireEvent.pointerUp(bar, { pointerId: 1, screenX: 1500, screenY: 400 });
    expect(emitDockBack).not.toHaveBeenCalled();
  });

  it("shows the dock-back hint once the press becomes a drag", async () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    const tab = container.querySelector("[data-tab]")!;
    const bar = container.querySelector(".detached-bar")!;
    fireEvent.pointerDown(tab, { pointerId: 1, screenX: 200, screenY: 120, clientX: 40, clientY: 16 });
    await flush();
    fireEvent.pointerMove(bar, { pointerId: 1, screenX: 400, screenY: 300, clientX: 240, clientY: 200 });
    expect(screen.getByText(/release over the main window to dock back/)).toBeTruthy();
  });
});
