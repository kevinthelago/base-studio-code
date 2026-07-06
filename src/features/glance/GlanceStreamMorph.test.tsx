import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GlanceStreamMorph } from "./GlanceStreamMorph";

// Same stubs as the dock test: xterm can't init in jsdom, and the Logs tab polls `bsc`. We test the
// morph SHELL — that it hosts the live terminal for the pane id, and that closing morphs back → onClose.
vi.mock("@/app/console/panes/views/TerminalView", () => ({
  TerminalView: ({ paneId }: { paneId: string }) => <div data-testid="terminal" data-pane={paneId} />,
}));
vi.mock("./GlanceSessionLog", () => ({ GlanceSessionLog: () => <div data-testid="logs" /> }));
vi.mock("@/shared/lib/core/safeInvoke", () => ({ fireInvoke: vi.fn() }));

describe("GlanceStreamMorph (#2401)", () => {
  afterEach(() => vi.useRealTimers());

  it("hosts the agent's live terminal (its identity pane id) inside the morph panel", () => {
    render(<GlanceStreamMorph nodeId="api-client" paneId="proj:api-client" name="api-client" role="worker" onClose={() => {}} />);
    expect(screen.getByText("api-client")).toBeInTheDocument();
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-pane", "proj:api-client");
  });

  it("morphs back → fires onClose after the exit transition, not before", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph nodeId="api-client" paneId="proj:api-client" name="api-client" onClose={onClose} />);
    // The dock's ✕ triggers the morph-back — onClose is deferred until the panel returns to the node.
    fireEvent.click(screen.getByRole("button", { name: "Close stream" }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(500); }); // past the exit fallback
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph nodeId="api-client" paneId="proj:api-client" name="api-client" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
