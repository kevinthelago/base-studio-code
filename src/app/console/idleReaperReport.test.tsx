// WHAT THE REAPER IS TOLD IS ON SCREEN — asserted on the payload the backend actually receives.
//
// The backend's one unconditional protection is `if (on_screen) return false`. It used to be fed a
// SINGLE pane id, built from the console grid's `focusedPaneIdx`:
//
//     fireInvoke("pty_report_focus", { paneId: focused || null });
//
// A studio session, a graph session and a network architect are not console panes and never will be,
// so that guard was unreachable for every session the app owns. MEASURED on the live store
// (~/.local/share/com.basestudio.code/app-state.json, 2026-09-01): `focusedPaneIdx` was unset and the
// active workspace was `glance`, so the app reported NULL — nothing whatsoever was protected while the
// user worked in the graphs. With the ten-second idle grace this config resolves to, that is the whole
// of "system sessions in the components, algorithms and other graphs are ending".
//
// `TerminalHost` is mocked rather than rendered because the DERIVATION is pinned next door
// (`TerminalHost.test.tsx`, `onScreenPaneIds`), and what is untested is the WIRING — that the hook
// asks it at all, and that the console pane is unioned in rather than replaced by it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { useIdleReaper } from "@/app/console/lib/useIdleReaper";

const ON_SCREEN = [
  "design-studio:designer-react",     // a studio, docked on the Components page
  "network-finance:architect",        // a network architect, open in a Glance morph
];
vi.mock("@/app/console/terminal/TerminalHost", () => ({
  onScreenPaneIdsNow: () => [...ON_SCREEN],
}));

function Harness() {
  useIdleReaper();
  return null;
}

/** The last `pty_report_onscreen` payload, or undefined if the hook never reported. */
const reported = () => {
  const calls = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "pty_report_onscreen");
  const last = calls.length > 0 ? calls[calls.length - 1] : undefined;
  return (last?.[1] as { paneIds?: string[] } | undefined)?.paneIds;
};

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  useAppStore.setState({ focusedPaneIdx: -1, activeTabIdx: 0, tabs: [] });
});
afterEach(cleanup);

describe("what the idle reaper reports as on screen", () => {
  it("carries the app-owned sessions a surface is showing, with no console pane at all", () => {
    // The measured case: no console pane is focused, and two app-owned sessions are on screen. The
    // old report was `{ paneId: null }` here — the exact shape that protected nothing.
    render(<Harness />);
    expect(reported(), "the hook never reported anything").toBeTruthy();
    expect(reported()).toEqual([...ON_SCREEN].sort());
  });

  it("UNIONS the focused console pane in rather than replacing it", () => {
    // Neither answer subsumes the other: `focusedPaneIdx` is the keyboard cursor inside the grid,
    // while the host answers about what is rendered. Both are reasons not to reap.
    useAppStore.setState({
      focusedPaneIdx: 0,
      activeTabIdx: 0,
      tabs: [{ id: "t1", panes: [{ paneId: "twitter-clone-test:api" }] }] as never,
    });
    render(<Harness />);
    const ids = reported() ?? [];
    for (const id of ON_SCREEN) expect(ids, `${id} must survive the union`).toContain(id);
    expect(ids.length).toBeGreaterThan(ON_SCREEN.length);
  });

  it("reports the SET verb, never the retired single-id one", () => {
    // `pty_report_focus` no longer exists in the backend. Sending it would be a silent no-op — the
    // command is simply not registered — so nothing would ever be protected again and no error would
    // say so. Pinned because that failure is invisible at runtime.
    render(<Harness />);
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "pty_report_focus")).toBe(false);
    expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "pty_report_onscreen")).toBe(true);
  });
});
