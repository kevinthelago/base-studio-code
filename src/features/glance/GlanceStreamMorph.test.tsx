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

  it("a CLICK outside the card closes it (#2537)", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    // Press + release on the graph background (outside the card), no movement → a click → close.
    fireEvent.mouseDown(document.body, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(document.body, { clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("a DRAG (pan) outside the card leaves it open — the graph keeps its gesture (#2537)", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    // Press then release far away (moved past the 4px threshold) → a pan, not a click → stays open.
    fireEvent.mouseDown(document.body, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(document.body, { clientX: 120, clientY: 90 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a press that STARTS inside the card never closes it (#2537)", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { container } = render(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    const card = container.querySelector(".glance-card") as HTMLElement;
    fireEvent.mouseDown(card, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(document.body, { clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reveals edge + corner resize handles only once expanded (#2659/#2662)", () => {
    vi.useFakeTimers();
    const { container } = render(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" onClose={() => {}} />);
    expect(screen.queryByLabelText("Resize se")).toBeNull();       // collapsed into the node → no handles
    act(() => { vi.advanceTimersByTime(20); });                    // flush the grow rAF → expanded
    // All four edges + four corners are grabbable (a standard resize affordance, #2662).
    for (const dir of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
      expect(screen.getByLabelText(`Resize ${dir}`)).toBeInTheDocument();
    }
    expect(container.querySelectorAll('[aria-label^="Resize "]')).toHaveLength(8);
  });

  it("reports its expanded world box up, and clears it on close (#2662)", () => {
    vi.useFakeTimers();
    const onRect = vi.fn();
    render(<GlanceStreamMorph node={NODE} paneId="proj:api-client" name="api-client" onRect={onRect} onClose={() => {}} />);
    act(() => { vi.advanceTimersByTime(20); });                    // expand → reports a rect
    const reported = onRect.mock.calls.map((c) => c[0]).filter(Boolean);
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[reported.length - 1]).toMatchObject({ w: expect.any(Number), h: expect.any(Number) });
    onRect.mockClear();
    fireEvent.keyDown(window, { key: "Escape" });                 // close → releases the neighbours
    expect(onRect).toHaveBeenCalledWith(null);
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
