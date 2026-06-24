import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./";

/**
 * #1221: requestPaneRedraw bumps a per-pane counter that the pane's terminal watches to fire a
 * resize-nudge (SIGWINCH) that un-jumbles the Claude CLI's TUI. The manual menu item and the
 * Ctrl+Shift+R hotkey both call requestPaneRedraw — this pins that contract.
 */
describe("requestPaneRedraw / paneRedrawNonce (#1221)", () => {
  beforeEach(() => {
    useAppStore.setState({ paneRedrawNonce: {} });
  });

  it("bumps the pane's nonce monotonically, scoped per pane", () => {
    const { requestPaneRedraw } = useAppStore.getState();
    expect(useAppStore.getState().paneRedrawNonce["t0p0"]).toBeUndefined();
    requestPaneRedraw("t0p0");
    expect(useAppStore.getState().paneRedrawNonce["t0p0"]).toBe(1);
    requestPaneRedraw("t0p0");
    expect(useAppStore.getState().paneRedrawNonce["t0p0"]).toBe(2);
    // a different pane is independent
    requestPaneRedraw("t0p1");
    expect(useAppStore.getState().paneRedrawNonce["t0p1"]).toBe(1);
    expect(useAppStore.getState().paneRedrawNonce["t0p0"]).toBe(2);
  });
});
