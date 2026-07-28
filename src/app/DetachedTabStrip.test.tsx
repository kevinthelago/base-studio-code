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

  it("names the DOCK-BACK action in the drag preview, not 'open in a new window'", () => {
    const { container } = render(<DetachedTabStrip page="github" section="repos" label="Repos" />);
    const tab = container.querySelector("[data-tab]")!;
    fireEvent.dragStart(tab, { dataTransfer: { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" } });
    fireEvent(window, new MouseEvent("dragover", { bubbles: true, clientX: 900, clientY: 900 }));
    expect(screen.getByText(/dock back into the main window/)).toBeTruthy();
    expect(screen.queryByText(/open in a new window/)).toBeNull();
  });
});
