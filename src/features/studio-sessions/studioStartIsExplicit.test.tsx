// #rendering-a-studio-node-must-not-start-its-session — showing a studio must not start it.
//
// `useStudioViewer` used to call `openStudio` alongside `addStudioViewer`, so any surface that SHOWED a
// studio also LAUNCHED it. `useStudioPageShowing` is true whenever the shell is on that page, so merely
// NAVIGATING to the Design Studio put `designer` into `wantedStudios` → `StudioSessionMount` → a live PTY.
// The 30-minute reaper then dropped it and navigating back started it again, which reads from outside as
// sessions starting themselves.
//
// Two invariants are pinned here, and they are deliberately opposed: viewing must NOT start, and the
// start control MUST. Only asserting the first would be satisfied by a studio that can never run at all.
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { render, screen, fireEvent } from "@testing-library/react";
import { useAppStore } from "@/store";
import { useStudioViewer, useStudioViewers } from "./useStudioViewer";
import { StudioTerminalSlot, AgentTerminalSlot } from "./StudioTerminalSlot";
import { STUDIO_SESSIONS } from "./lib/studioSessions";

beforeEach(() => {
  useAppStore.setState({ wantedStudios: [], studioViewers: {} });
});

describe("viewing a studio does not start it", () => {
  it("useStudioViewer leaves wantedStudios untouched — the regression this item exists for", () => {
    renderHook(() => useStudioViewer("designer", true));
    expect(useAppStore.getState().wantedStudios, "showing must not start").toEqual([]);
  });

  it("...but it DOES register as a viewer, so a running session stays pinned against the reaper", () => {
    // The half that must survive: if viewing stopped pinning, watching a live session could get it
    // reaped out from under you. That is why this is a split rather than a deletion.
    const { unmount } = renderHook(() => useStudioViewer("designer", true));
    expect(useAppStore.getState().studioViewers.designer).toBe(1);
    unmount();
    expect(useAppStore.getState().studioViewers.designer).toBe(0);
  });

  it("useStudioViewers (the Glance morph form) starts none of them either", () => {
    renderHook(() => useStudioViewers(["designer", "librarian"]));
    expect(useAppStore.getState().wantedStudios).toEqual([]);
    expect(useAppStore.getState().studioViewers.designer).toBe(1);
    expect(useAppStore.getState().studioViewers.librarian).toBe(1);
  });

  it("a page that is mounted but NOT showing registers nothing at all", () => {
    renderHook(() => useStudioViewer("designer", false));
    expect(useAppStore.getState().wantedStudios).toEqual([]);
    expect(useAppStore.getState().studioViewers.designer ?? 0).toBe(0);
  });
});

describe("StudioTerminalSlot — the start control is the only way up", () => {
  it("renders the not-running placeholder instead of a terminal when the studio is down", () => {
    render(<StudioTerminalSlot studio="designer" />);
    expect(screen.getByTestId("studio-not-running-designer")).toBeTruthy();
  });

  it("pressing Start is what puts the studio in wantedStudios", () => {
    render(<StudioTerminalSlot studio="designer" />);
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    expect(useAppStore.getState().wantedStudios).toEqual(["designer"]);
  });

  it("shows the terminal (no placeholder) once the studio is running", () => {
    useAppStore.setState({ wantedStudios: ["designer"] });
    render(<StudioTerminalSlot studio="designer" />);
    expect(screen.queryByTestId("studio-not-running-designer")).toBeNull();
  });
});

describe("AgentTerminalSlot routes by pane id", () => {
  it("a studio pane gets the start control", () => {
    render(<AgentTerminalSlot paneId={STUDIO_SESSIONS.librarian.paneId} />);
    expect(screen.getByTestId("studio-not-running-librarian")).toBeTruthy();
  });

  it("a NON-studio pane is untouched — a fleet worker must not grow a Start button", () => {
    render(<AgentTerminalSlot paneId="demo:api" />);
    expect(screen.queryByTestId(/^studio-not-running-/)).toBeNull();
    expect(screen.queryByRole("button", { name: /start/i })).toBeNull();
  });
});
