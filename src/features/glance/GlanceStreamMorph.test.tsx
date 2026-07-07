import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GlanceStreamMorph } from "./GlanceStreamMorph";
import { useAppStore } from "@/store";

// Same stubs as the dock test: xterm can't init in jsdom, and the Logs tab polls `bsc`. We test the
// morph SHELL — that it hosts the live terminal for the pane id IN the graph (no portal/scrim, #2534),
// and that closing morphs back → onClose. The dock renders TerminalSlot since the single Terminal Host
// landed (#2378) — mock the slot, not the old direct TerminalView (which the dock no longer mounts).
vi.mock("@/app/console/terminal/TerminalSlot", () => ({
  TerminalSlot: ({ paneId }: { paneId: string }) => <div data-testid="terminal" data-pane={paneId} />,
}));
vi.mock("./GlanceSessionLog", () => ({ GlanceSessionLog: () => <div data-testid="logs" /> }));
vi.mock("@/shared/lib/core/safeInvoke", () => ({ fireInvoke: vi.fn() }));

const NODE = { x: 100, y: 100 };

describe("GlanceStreamMorph (#2401/#2534)", () => {
  beforeEach(() => useAppStore.setState({ paneStatus: {} }));
  afterEach(() => vi.useRealTimers());

  it("hosts the agent's live terminal (its identity pane id) inside the in-graph card", () => {
    const { container } = render(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" role="worker" onClose={() => {}} />);
    expect(screen.getByText("api-client")).toBeInTheDocument();
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-pane", "proj:api-client");
    // It lives IN the graph (a world-layer child of the render container), NOT a full-screen portal +
    // scrim mounted to document.body (#2534).
    expect(container.querySelector(".glance-card")).not.toBeNull();
    expect(document.querySelector(".glance-morph")).toBeNull();
    expect(document.querySelector(".glance-morph-scrim")).toBeNull();
  });

  it("morphs back → fires onClose after the exit transition, not before", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    // The dock's ✕ triggers the morph-back — onClose is deferred until the card returns to the node.
    fireEvent.click(screen.getByRole("button", { name: "Close stream" }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(500); }); // past the exit fallback
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("hides the chat input while the CLI is running, showing it at rest (#2534)", () => {
    // At rest (no "run" status) the message input is present.
    const { rerender } = render(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" onClose={() => {}} />);
    expect(screen.getByPlaceholderText("Message the agent — Enter to send")).toBeInTheDocument();
    // A turn opens ("run") → the input is hidden and a working affordance takes its place.
    act(() => useAppStore.setState({ paneStatus: { "proj:api-client": "run" } }));
    rerender(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" onClose={() => {}} />);
    expect(screen.queryByPlaceholderText("Message the agent — Enter to send")).toBeNull();
    expect(screen.getByText(/working — input returns/)).toBeInTheDocument();
  });
});
