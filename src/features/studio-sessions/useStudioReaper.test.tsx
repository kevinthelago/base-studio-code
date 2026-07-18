import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { useStudioReaper, STUDIO_IDLE_MS, STUDIO_BUSY_RECHECK_MS } from "./useStudioReaper";
import { STUDIO_SESSIONS } from "./lib/studioSessions";

/**
 * #3357 — the idle reaper. A studio session deliberately OUTLIVES the surface that opened it (so the
 * Glance node can still morph into it after you leave its page), so something has to reclaim it. Rule:
 * unwatched for 30 minutes ⇒ dropped from `wantedStudios`, which unmounts its TerminalHost claim and tears
 * the PTY down — unless Claude is mid-turn, in which case it defers rather than cutting the session off.
 */

const invokeMock = vi.mocked(invoke);
const killedPanes = () =>
  invokeMock.mock.calls.filter(([c]) => c === "pty_kill").map(([, a]) => (a as { paneId: string }).paneId);

beforeEach(() => {
  vi.useFakeTimers();
  invokeMock.mockClear();
  useAppStore.setState({ wantedStudios: [], studioViewers: {}, paneClaudeActive: {} });
});
afterEach(() => vi.useRealTimers());

describe("useStudioReaper (#3357)", () => {
  it("does nothing while a surface is showing the studio", () => {
    useAppStore.setState({ wantedStudios: ["designer"], studioViewers: { designer: 1 } });
    renderHook(() => useStudioReaper());
    act(() => { vi.advanceTimersByTime(STUDIO_IDLE_MS * 3); });
    expect(useAppStore.getState().wantedStudios).toEqual(["designer"]);
  });

  it("arms on the viewer count dropping to 0 and reaps at expiry", () => {
    useAppStore.setState({ wantedStudios: ["designer"], studioViewers: { designer: 1 } });
    const { rerender } = renderHook(() => useStudioReaper());

    act(() => { useAppStore.getState().removeStudioViewer("designer"); });
    rerender();
    // Still warm right up to the deadline — leaving the page must not kill the session.
    act(() => { vi.advanceTimersByTime(STUDIO_IDLE_MS - 1); });
    expect(useAppStore.getState().wantedStudios).toEqual(["designer"]);

    act(() => { vi.advanceTimersByTime(1); });
    expect(useAppStore.getState().wantedStudios).toEqual([]);
    // The reclaim must be COMPLETE: dropping the TerminalHost claim only unmounts the xterm (TerminalView
    // deliberately leaves the backend session alive for reconnect), so the reaper kills the PTY itself.
    expect(killedPanes()).toEqual([STUDIO_SESSIONS.designer.paneId]);
  });

  it("re-opening before expiry cancels the reap (and the session is never restarted)", () => {
    useAppStore.setState({ wantedStudios: ["designer"], studioViewers: { designer: 1 } });
    const { rerender } = renderHook(() => useStudioReaper());

    act(() => { useAppStore.getState().removeStudioViewer("designer"); });
    rerender();
    act(() => { vi.advanceTimersByTime(STUDIO_IDLE_MS / 2); });
    // The user comes back (page dock or the Glance morph) → viewer count > 0 → disarm.
    act(() => { useAppStore.getState().addStudioViewer("designer"); });
    rerender();
    act(() => { vi.advanceTimersByTime(STUDIO_IDLE_MS * 2); });
    expect(useAppStore.getState().wantedStudios).toEqual(["designer"]);
  });

  it("DEFERS the kill while Claude is actively running, then reaps once the turn ends", () => {
    useAppStore.setState({
      wantedStudios: ["librarian"],
      studioViewers: { librarian: 0 },
      paneClaudeActive: { [STUDIO_SESSIONS.librarian.paneId]: true },
    });
    renderHook(() => useStudioReaper());

    // Expiry lands mid-turn: re-arm instead of cutting the agent off.
    act(() => { vi.advanceTimersByTime(STUDIO_IDLE_MS); });
    expect(useAppStore.getState().wantedStudios).toEqual(["librarian"]);
    act(() => { vi.advanceTimersByTime(STUDIO_BUSY_RECHECK_MS * 5); });
    expect(useAppStore.getState().wantedStudios).toEqual(["librarian"]);
    expect(killedPanes()).toEqual([]); // never cut a working session off mid-turn

    // The turn closes → the next recheck reclaims it.
    act(() => { useAppStore.setState({ paneClaudeActive: {} }); });
    act(() => { vi.advanceTimersByTime(STUDIO_BUSY_RECHECK_MS); });
    expect(useAppStore.getState().wantedStudios).toEqual([]);
  });

  it("reaps each studio independently — one going idle never touches another", () => {
    useAppStore.setState({
      wantedStudios: ["designer", "architect"],
      studioViewers: { designer: 0, architect: 1 },
    });
    renderHook(() => useStudioReaper());
    act(() => { vi.advanceTimersByTime(STUDIO_IDLE_MS); });
    expect(useAppStore.getState().wantedStudios).toEqual(["architect"]);
  });

  it("does not restart the countdown when an unrelated studio's viewer count changes", () => {
    useAppStore.setState({ wantedStudios: ["designer", "architect"], studioViewers: { designer: 0, architect: 1 } });
    const { rerender } = renderHook(() => useStudioReaper());
    act(() => { vi.advanceTimersByTime(STUDIO_IDLE_MS - 1000); });
    // A churn event on the OTHER studio re-runs the reconcile effect; the armed timer must survive it.
    act(() => { useAppStore.getState().addStudioViewer("architect"); });
    rerender();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(useAppStore.getState().wantedStudios).toEqual(["architect"]);
  });
});
