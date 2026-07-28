// The detached window's strip + the dock-back gesture (#3919).
//
// jsdom cannot run a real OS drag, so these pin the WIRING: that the strip presents its tab, that the
// tear-off callback docks back rather than tearing off again, and that the preview names the right action.
// The gesture itself is verified against the running app.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const emitDockBack = vi.fn().mockResolvedValue(undefined);
const close = vi.fn().mockResolvedValue(undefined);
vi.mock("@/shared/lib/core/dockBack", () => ({
  emitDockBack: (p: unknown) => emitDockBack(p),
  DOCK_BACK_EVENT: "bsc://dock-back",
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close }) }));

import { DetachedTabStrip } from "./DetachedTabStrip";

beforeEach(() => { emitDockBack.mockClear(); close.mockClear(); });

describe("DetachedTabStrip (#3919)", () => {
  it("presents the page's tab, so there is something to grab", () => {
    render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    // The tab itself — a detached window used to render a bare titlebar with nothing draggable.
    expect(screen.getAllByText("Repos").length).toBeGreaterThan(0);
  });

  it("docks back when the tab is dragged off the strip — the INVERSION of tear-off", () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    const strip = container.querySelector(".tabstrip")!;
    const tab = container.querySelector("[data-tab]")!;
    // Start the drag, then release far outside the strip's box — TabBar's tear-off path.
    fireEvent.dragStart(tab, { dataTransfer: { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" } });
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 900, clientY: 900 }));
    fireEvent(window, new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 900, clientY: 900 }));
    expect(strip).toBeTruthy();
    expect(emitDockBack).toHaveBeenCalledWith({ page: "github", section: "repos" });
  });

  it("docks back when the tab is released OUTSIDE the window — the natural gesture (#3925)", () => {
    // HTML5 drag events only reach the source document while the pointer is over it, so dropping the tab
    // onto the MAIN window delivers no `drop` here. `dragend` fires on the source element regardless, and
    // it is the only signal for the gesture users actually make: drag toward the other window and release.
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    const tab = container.querySelector("[data-tab]")!;
    fireEvent.dragStart(tab, { dataTransfer: { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" } });
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 900, clientY: 900 }));
    fireEvent.dragEnd(tab); // released over another window — NO drop event reaches this document
    expect(emitDockBack).toHaveBeenCalledWith({ page: "github", section: "repos" });
  });

  it("does not dock back twice when the release happens INSIDE the window", () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    const tab = container.querySelector("[data-tab]")!;
    fireEvent.dragStart(tab, { dataTransfer: { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" } });
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 900, clientY: 900 }));
    fireEvent(window, new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 900, clientY: 900 }));
    fireEvent.dragEnd(tab); // dragend ALWAYS follows drop — must not fire a second time
    expect(emitDockBack).toHaveBeenCalledTimes(1);
  });

  it("does NOT dock back when the drag ends back on the strip — a cancelled gesture", () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    const strip = container.querySelector(".tabstrip") as HTMLElement;
    strip.getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 40, width: 400, height: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const tab = container.querySelector("[data-tab]")!;
    fireEvent.dragStart(tab, { dataTransfer: { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" } });
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 900, clientY: 900 })); // out…
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 100, clientY: 20 }));  // …and back
    fireEvent.dragEnd(tab);
    expect(emitDockBack).not.toHaveBeenCalled();
  });

  it("carries the window controls in the SAME bar — no separate titlebar, no breadcrumb", () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    expect(container.querySelector(".tabstrip.chrome-bar"), "the one-bar chrome").toBeTruthy();
    expect(container.querySelector(".tabstrip .tabstrip-trailing"), "controls inside the strip").toBeTruthy();
    expect(container.querySelector(".titlebar"), "no second bar").toBeNull();
    expect(screen.queryByText(/github · Repos/), "no breadcrumb").toBeNull();
  });

  it("names the DOCK-BACK action in the drag preview, not 'open in a new window'", () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    const tab = container.querySelector("[data-tab]")!;
    fireEvent.dragStart(tab, { dataTransfer: { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" } });
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 900, clientY: 900 }));
    expect(screen.getByText(/dock back into the main window/)).toBeTruthy();
    expect(screen.queryByText(/open in a new window/)).toBeNull();
  });
});
