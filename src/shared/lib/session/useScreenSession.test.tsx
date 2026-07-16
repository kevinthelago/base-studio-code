import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { useScreenSession } from "./useScreenSession";

// #2832 — the mount RAF must NOT fit a zero-size host: fitting sets the terminal to 0 rows, and the
// first pty_data write to a 0-row terminal crashes xterm ("Cannot set properties of undefined (setting
// 'isWrapped')"). Before the guard, `fitAddon.fit()` ran unconditionally; jsdom reports 0 layout, so
// this test (fit NOT called on a 0-size host, and no throw) fails on the pre-fix code and passes now.
// (The companion fix — debouncing the ResizeObserver so a resize DRAG reflows once instead of on every
// frame — is a live-terminal behavior exercised in the running app; the ResizeObserver is stubbed here.)

// xterm can't initialize in jsdom — stub it (same pattern as the terminal tests). The FitAddon's `fit`
// is a HOISTED shared spy so the test can assert whether the mount RAF called it.
const { fitSpy } = vi.hoisted(() => ({ fitSpy: vi.fn() }));
vi.mock("@xterm/xterm", () => {
  class Terminal {
    cols = 80;
    rows = 24;
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    dispose = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => "");
  }
  return { Terminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = fitSpy; } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

beforeAll(() => {
  // jsdom reports 0 layout; run rAF synchronously so the mount fit-check fires in-test.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});
beforeEach(() => fitSpy.mockClear());
afterEach(() => cleanup());

function Harness() {
  const { containerRef } = useScreenSession({
    paneId: "test:pane",
    termTheme: {} as never,
    visible: true,
    exitBanner: "",
    launch: async () => {},
  });
  return <div ref={containerRef} data-testid="host" />;
}

describe("useScreenSession — fit guard (#2832)", () => {
  it("does NOT fit a zero-size host (the xterm 0-rows crash guard) and mounts without throwing", async () => {
    // jsdom: the host's clientWidth/clientHeight are 0.
    expect(() => render(<Harness />)).not.toThrow();
    await waitFor(() => {});
    expect(fitSpy).not.toHaveBeenCalled();
  });
});
