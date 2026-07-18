import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlanceTerminalGrid, type GlanceOpenSession } from "./GlanceTerminalGrid";
import { useAppStore } from "@/store";
import { gridShape } from "./lib/terminalGrid";

// The real terminal is owned by the app-level TerminalHost; stub the slot so these tests cover the GRID
// (cell count · per-cell wiring · the paneId each cell claims) without an xterm.
vi.mock("@/app/console/terminal/TerminalSlot", () => ({
  TerminalSlot: ({ paneId, visible }: { paneId: string; visible: boolean }) => (
    <div data-testid="terminal" data-pane={paneId} data-visible={visible} />
  ),
}));
vi.mock("./GlanceSessionLog", () => ({
  GlanceSessionLog: ({ paneId }: { paneId: string }) => <div data-testid="logs" data-pane={paneId} />,
}));
vi.mock("@/shared/lib/core/safeInvoke", () => ({ fireInvoke: vi.fn() }));

const session = (n: string): GlanceOpenSession => ({ nodeId: n, paneId: `proj:${n}`, name: n, role: "worker" });

describe("GlanceTerminalGrid (#3361 — several nodes open, auto-arranged, never overlapping)", () => {
  beforeEach(() => { vi.clearAllMocks(); useAppStore.setState({ paneStatus: {} }); });

  it("renders NOTHING when no session is open, so the dock takes no height", () => {
    const { container } = render(<GlanceTerminalGrid sessions={[]} onClose={() => {}} onEnd={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one cell per open session — the regression the single-slot morph could not pass", () => {
    render(<GlanceTerminalGrid sessions={[session("api"), session("web"), session("db")]} onClose={() => {}} onEnd={() => {}} />);
    // Before #3361 opening a second node REPLACED the first (one keyed <GlanceStreamMorph>); all three
    // must now coexist, each mounting its own pane's terminal.
    for (const id of ["api", "web", "db"]) {
      expect(screen.getByTestId(`glance-terminal-cell-${id}`)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId("terminal").map((t) => t.getAttribute("data-pane")))
      .toEqual(["proj:api", "proj:web", "proj:db"]);
  });

  it("lays the cells out on the gridShape for the open count — the guarantee that they cannot overlap", () => {
    const { rerender } = render(<GlanceTerminalGrid sessions={[session("a"), session("b")]} onClose={() => {}} onEnd={() => {}} />);
    // Assert the COLUMN/ROW COUNT rather than the exact template string — the browser/jsdom is free to
    // re-serialize the `minmax()` spacing, and the count is the property that guarantees no overlap.
    const gridOf = () => screen.getByTestId("glance-terminal-grid").querySelector<HTMLElement>("[style*='grid-template-columns']")!;
    expect(gridOf().style.gridTemplateColumns).toContain(`repeat(${gridShape(2).cols},`);

    rerender(<GlanceTerminalGrid sessions={["a", "b", "c", "d", "e"].map(session)} onClose={() => {}} onEnd={() => {}} />);
    expect(gridOf().style.gridTemplateColumns).toContain(`repeat(${gridShape(5).cols},`);
    expect(gridOf().style.gridTemplateRows).toContain(`repeat(${gridShape(5).rows},`);
  });

  it("closes ONLY the clicked cell — its siblings stay open", () => {
    const onClose = vi.fn();
    render(<GlanceTerminalGrid sessions={[session("api"), session("web")]} onClose={onClose} onEnd={() => {}} />);
    const closes = screen.getAllByRole("button", { name: "Collapse stream (agent stays alive)" });
    expect(closes).toHaveLength(2);
    fireEvent.click(closes[1]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith("web");   // the node id, not an index — the caller filters by it
  });

  it("ends ONLY the clicked cell's session", () => {
    const onEnd = vi.fn();
    render(<GlanceTerminalGrid sessions={[session("api"), session("web")]} onClose={() => {}} onEnd={onEnd} />);
    fireEvent.click(screen.getAllByRole("button", { name: "End session" })[0]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("api");
  });

  it("keys cells by paneId so re-ordering never remounts a terminal onto the wrong pane", () => {
    const { rerender } = render(<GlanceTerminalGrid sessions={[session("api"), session("web")]} onClose={() => {}} onEnd={() => {}} />);
    const first = screen.getByTestId("glance-terminal-cell-api");
    // A sibling opening ahead of it re-orders the list; `api`'s cell must be the SAME element, or its
    // TerminalSlot would unmount and re-register — dropping the host claim and tearing the PTY down.
    rerender(<GlanceTerminalGrid sessions={[session("db"), session("api"), session("web")]} onClose={() => {}} onEnd={() => {}} />);
    expect(screen.getByTestId("glance-terminal-cell-api")).toBe(first);
  });

  it("summarises the open count in the dock header", () => {
    const { rerender } = render(<GlanceTerminalGrid sessions={[session("api")]} onClose={() => {}} onEnd={() => {}} />);
    expect(screen.getByText("1 open session")).toBeInTheDocument();
    rerender(<GlanceTerminalGrid sessions={[session("api"), session("web")]} onClose={() => {}} onEnd={() => {}} />);
    expect(screen.getByText("2 open sessions")).toBeInTheDocument();
  });
});
