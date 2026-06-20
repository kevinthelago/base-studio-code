import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { ConsoleScreen } from "../../../screens/Console";
import { useAppStore } from "../../../store";
import type { ViewKey } from "../ViewTabs";
import type { McpServer } from "../../../lib/session/mcpServers";
import type { Hook } from "../../../lib/session/hooks";

/**
 * #186: every tab's panes stay mounted across switches so xterm + frontend
 * scrollback survive. Inactive tabs are display:none, not unmounted; switching
 * tabs flips the display on the same DOM nodes rather than disposing and
 * recreating them.
 */

// xterm doesn't initialize cleanly in jsdom (term.open needs real DOM
// measurements). Stub TerminalView so the screen renders without spinning up a
// terminal per pane — we're testing the screen's mount/visibility behavior,
// not xterm itself.
vi.mock("./TerminalView", () => ({
  TerminalView: ({ paneId, visible }: { paneId: string; visible: boolean }) =>
    <div data-testid={`term-${paneId}`} data-visible={String(visible)} />,
}));

const RESET = {
  tabs: [
    { name: "alpha · triage", layout: "2×2", state: "idle" as const, runId: 0 },
    { name: "beta · build",   layout: "1×1", state: "idle" as const, runId: 0 },
  ],
  activeTabIdx: 0,
  paneMenuOpenIdx: -1,
  focusedPaneIdx: -1,
  fullscreenPaneIdx: -1,
  paneViews: [] as ViewKey[],
  paneNames: {} as Record<number, Record<number, string>>,
  paneCwds: {} as Record<string, string>,
  paneInitCmds: {} as Record<string, string>,
  disabledPanes: {} as Record<string, boolean>,
  paneAllowedCommands: {} as Record<string, string[]>,
  paneStartupPromptText: {} as Record<string, string>,
  paneStartupPromptDocs: {} as Record<string, string>,
  paneCheckpointDocs: {} as Record<string, string>,
  paneContinue: {} as Record<string, boolean>,
  paneMcpServers: {} as Record<string, McpServer[]>,
  paneHooks: {} as Record<string, Hook[]>,
  consoleBroadcast: false,
  autoAdvanceOnReply: true,
};

describe("ConsoleScreen cross-tab pane mounting (#186)", () => {
  beforeEach(() => { useAppStore.setState(RESET); });

  it("renders one console-grid per tab, not just the active one", () => {
    const { container } = render(<ConsoleScreen />);
    const grids = container.querySelectorAll(".console-grid");
    expect(grids.length).toBe(2);
  });

  it("mounts every tab's panes so background-tab terminals stay alive", () => {
    const { container } = render(<ConsoleScreen />);
    // Tab 0 (alpha) has a 2×2 grid → 4 panes; tab 1 (beta) has 1×1 → 1 pane.
    expect(container.querySelector(`[data-testid='term-t0p0']`)).toBeTruthy();
    expect(container.querySelector(`[data-testid='term-t0p3']`)).toBeTruthy();
    expect(container.querySelector(`[data-testid='term-t1p0']`)).toBeTruthy();
  });

  it("shows the active tab's grid (display:grid) and hides the rest (display:none)", () => {
    const { container } = render(<ConsoleScreen />);
    const grids = Array.from(container.querySelectorAll(".console-grid")) as HTMLElement[];
    expect(grids[0].style.display).toBe("grid"); // active
    expect(grids[1].style.display).toBe("none");
  });

  it("switching tabs swaps display without remounting the DOM nodes", () => {
    const { container } = render(<ConsoleScreen />);
    const gridsBefore = Array.from(container.querySelectorAll(".console-grid")) as HTMLElement[];
    const termBefore  = container.querySelector(`[data-testid='term-t1p0']`);

    act(() => { useAppStore.setState({ activeTabIdx: 1 }); });

    const gridsAfter = Array.from(container.querySelectorAll(".console-grid")) as HTMLElement[];
    const termAfter  = container.querySelector(`[data-testid='term-t1p0']`);

    // Same grid wrapper nodes — not re-created on tab switch.
    expect(gridsAfter[0]).toBe(gridsBefore[0]);
    expect(gridsAfter[1]).toBe(gridsBefore[1]);
    // And the same TerminalView DOM (xterm + PTY listener survived).
    expect(termAfter).toBe(termBefore);
    // Display flipped.
    expect(gridsAfter[0].style.display).toBe("none");
    expect(gridsAfter[1].style.display).toBe("grid");
  });

  it("passes visible=false to background-tab panes so render pauses (#185 pairs here)", () => {
    const { container } = render(<ConsoleScreen />);
    // Tab 1 is the background tab on initial render.
    const bgTerm     = container.querySelector(`[data-testid='term-t1p0']`) as HTMLElement;
    const activeTerm = container.querySelector(`[data-testid='term-t0p0']`) as HTMLElement;
    expect(bgTerm.dataset.visible).toBe("false");
    expect(activeTerm.dataset.visible).toBe("true");

    // After switching, the previously-active tab's pane goes hidden — its
    // PendingPtyData (#185) starts buffering instead of writing to xterm.
    act(() => { useAppStore.setState({ activeTabIdx: 1 }); });
    expect(activeTerm.dataset.visible).toBe("false");
    expect(bgTerm.dataset.visible).toBe("true");
  });

});
