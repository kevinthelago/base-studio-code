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
// Since #3361 the morph grows into a GRID SLOT handed down by the canvas rather than a box it computes
// itself. SLOT is the slot-0 geometry for NODE — i.e. exactly the box this morph used to derive alone.
const SLOT = { left: -237, top: -127, w: 760, h: 520 };

describe("GlanceStreamMorph (#2401/#2534)", () => {
  beforeEach(() => useAppStore.setState({ paneStatus: {} }));
  afterEach(() => vi.useRealTimers());

  it("hosts the agent's live terminal (its identity pane id) inside the in-graph card", () => {
    const { container } = render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" role="worker" onClose={() => {}} />);
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
    render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    // The dock's ✕ triggers the morph-back — onClose is deferred until the card returns to the node.
    fireEvent.click(screen.getByRole("button", { name: "Collapse stream (agent stays alive)" }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(500); }); // past the exit fallback
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("CANCELS its pending exit onClose when unmounted before the timer fires (#3049)", () => {
    // The regression: with A's morph open, clicking another live node remounts a fresh morph (keyed by
    // paneId) — the OLD morph unmounts. Its delayed onClose (setChatNode(null)) must NOT fire afterwards,
    // or it collapses everything instead of GROWING the newly-clicked node.
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });  // schedules the deferred onClose
    unmount();                                     // superseded before the exit transition completes
    act(() => { vi.advanceTimersByTime(500); });   // the cancelled timer never fires
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders an End-session button that fires onEnd, and omits it without onEnd (#3049)", () => {
    const onEnd = vi.fn();
    const { rerender } = render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={() => {}} onEnd={onEnd} />);
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    expect(onEnd).toHaveBeenCalledOnce();
    // Without onEnd the affordance is absent (only the ✕ collapse remains).
    rerender(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "End session" })).toBeNull();
  });

  it("a CLICK outside the card closes it (#2537)", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    // Press + release on the graph background (outside the card), no movement → a click → close.
    fireEvent.mouseDown(document.body, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(document.body, { clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).toHaveBeenCalledOnce();
  });

  // #3365 — the regression that silently defeated multi-open (#3361). Clicking ANOTHER NODE to open a
  // second morph is a press outside THIS card, so the dismiss fired and the first morph closed the
  // instant the second opened: only one was ever visible, exactly as before the grid landed. A node
  // press is an OPEN/SELECT gesture and must never dismiss an already-open morph.
  it("a press on a graph NODE does NOT dismiss an open morph — opening a second node keeps the first (#3365)", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    // The canvas marks every node card with `data-glance-node` (GlanceCanvas) — stand one up here and
    // click it the way the user clicks a sibling node to open its session.
    const otherNode = document.createElement("div");
    otherNode.setAttribute("data-glance-node", "proj:web-ui");
    document.body.appendChild(otherNode);
    fireEvent.mouseDown(otherNode, { clientX: 40, clientY: 40 });
    fireEvent.mouseUp(otherNode, { clientX: 40, clientY: 40 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).not.toHaveBeenCalled();
    otherNode.remove();
  });

  it("a press on a CHILD of a graph node is exempt too — the label/dot inside the node card (#3365)", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    // The real press target is whatever is under the cursor — the node's slug text, its health dot —
    // never the marked wrapper itself, so the guard has to walk UP the tree (`closest`).
    const otherNode = document.createElement("div");
    otherNode.setAttribute("data-glance-node", "proj:web-ui");
    const label = document.createElement("span");
    otherNode.appendChild(label);
    document.body.appendChild(otherNode);
    fireEvent.mouseDown(label, { clientX: 40, clientY: 40 });
    fireEvent.mouseUp(label, { clientX: 40, clientY: 40 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).not.toHaveBeenCalled();
    otherNode.remove();
  });

  it("a DRAG (pan) outside the card leaves it open — the graph keeps its gesture (#2537)", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    // Press then release far away (moved past the 4px threshold) → a pan, not a click → stays open.
    fireEvent.mouseDown(document.body, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(document.body, { clientX: 120, clientY: 90 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a press that STARTS inside the card never closes it (#2537)", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { container } = render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={onClose} />);
    const card = container.querySelector(".glance-card") as HTMLElement;
    fireEvent.mouseDown(card, { clientX: 10, clientY: 10 });
    fireEvent.mouseUp(document.body, { clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(500); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reveals edge + corner resize handles only once expanded (#2659/#2662)", () => {
    vi.useFakeTimers();
    const { container } = render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={() => {}} />);
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
    render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onRect={onRect} onClose={() => {}} />);
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
    const { rerender } = render(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={() => {}} />);
    expect(screen.getByPlaceholderText("Message the agent — Enter to send")).toBeInTheDocument();
    // A turn opens ("run") → the input is hidden and a working affordance takes its place.
    act(() => useAppStore.setState({ paneStatus: { "proj:api-client": "run" } }));
    rerender(<GlanceStreamMorph node={NODE} slot={SLOT} paneId="proj:api-client" name="api-client" onClose={() => {}} />);
    expect(screen.queryByPlaceholderText("Message the agent — Enter to send")).toBeNull();
    expect(screen.getByText(/working — input returns/)).toBeInTheDocument();
  });
});
