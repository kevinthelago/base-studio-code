// The generic trace player (#3176) — render smoke: it renders the registered renderer for a structure,
// falls back (JSON dump) for an unregistered one, lays out multi-structure panels, and step-forward
// advances the frame.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TracePlayer } from "./TracePlayer";
import type { StructureRenderer } from "./registry";
import type { Frame } from "../lib/trace";

// A trivial array renderer for the tests (test files are exempt from the no-raw-div rule).
const ArrayView: StructureRenderer<"array"> = ({ frame }) => (
  <div data-testid="array-view">{frame.data.join(",")}</div>
);

// A factory yielding N single-array frames [0], [0,1], [0,1,2], … so a step changes visible content.
const arrayTrace = (): Generator<Frame> =>
  (function* () {
    for (let i = 1; i <= 3; i++) yield { structure: "array", data: Array.from({ length: i }, (_, k) => k) };
  })();

/** Matcher: the fallback's `<pre>` JSON dump (contains a `"structure"` key). */
const isJsonDump = (_: string, el: Element | null) =>
  el?.tagName === "PRE" && (el.textContent ?? "").includes('"structure"');

describe("TracePlayer (#3176)", () => {
  it("renders the registered renderer for a structure", () => {
    render(<TracePlayer factory={arrayTrace} renderers={{ array: ArrayView }} />);
    // Mount shows frame 0 → data [0].
    expect(screen.getByTestId("array-view").textContent).toBe("0");
  });

  it("falls back to a JSON dump for an unregistered structure (no crash)", () => {
    render(<TracePlayer factory={arrayTrace} renderers={{}} />);
    expect(screen.queryByTestId("array-view")).toBeNull();
    expect(screen.getByText(isJsonDump)).toBeTruthy();
  });

  it("lays out every named panel of a multi-structure frame", () => {
    const factory = (): Generator<Frame> =>
      (function* () {
        yield {
          panels: {
            values: { structure: "array", data: [7, 8] },
            grid: { structure: "matrix", data: [[1]] },
          },
        };
      })();
    render(<TracePlayer factory={factory} renderers={{ array: ArrayView }} />);
    // The array panel uses the registered renderer…
    expect(screen.getByTestId("array-view").textContent).toBe("7,8");
    // …and the matrix panel (unregistered) falls back to a JSON dump — both panels present.
    expect(screen.getByText(isJsonDump)).toBeTruthy();
  });

  it("advances the frame on step-forward", () => {
    render(<TracePlayer factory={arrayTrace} renderers={{ array: ArrayView }} />);
    expect(screen.getByTestId("array-view").textContent).toBe("0"); // frame 0
    fireEvent.click(screen.getByLabelText("Step forward"));
    expect(screen.getByTestId("array-view").textContent).toBe("0,1"); // frame 1
    fireEvent.click(screen.getByLabelText("Step forward"));
    expect(screen.getByTestId("array-view").textContent).toBe("0,1,2"); // frame 2
  });

  // ── #3199 inline-preview props ──

  it("hides the transport when controls is false (the inline preview is just the picture)", () => {
    render(<TracePlayer factory={arrayTrace} renderers={{ array: ArrayView }} controls={false} />);
    expect(screen.getByTestId("array-view").textContent).toBe("0"); // still shows frames
    expect(screen.queryByLabelText("Step forward")).toBeNull();
    expect(screen.queryByLabelText("Play")).toBeNull();
  });

  it("auto-plays without a click when autoPlay is set", () => {
    vi.useFakeTimers();
    try {
      render(<TracePlayer factory={arrayTrace} renderers={{ array: ArrayView }} autoPlay fps={10} />);
      expect(screen.getByTestId("array-view").textContent).toBe("0"); // frame 0 at mount
      act(() => void vi.advanceTimersByTime(100)); // one 100ms beat (fps 10)
      expect(screen.getByTestId("array-view").textContent).toBe("0,1"); // advanced with no click
    } finally {
      vi.useRealTimers();
    }
  });

  it("loops back to frame 0 at the end when loop is set", () => {
    vi.useFakeTimers();
    try {
      render(<TracePlayer factory={arrayTrace} renderers={{ array: ArrayView }} autoPlay loop fps={10} />);
      act(() => void vi.advanceTimersByTime(100)); // → "0,1"
      act(() => void vi.advanceTimersByTime(100)); // → "0,1,2" (last frame)
      expect(screen.getByTestId("array-view").textContent).toBe("0,1,2");
      act(() => void vi.advanceTimersByTime(100)); // end reached → loop restarts at frame 0
      expect(screen.getByTestId("array-view").textContent).toBe("0");
    } finally {
      vi.useRealTimers();
    }
  });

  // ── #3207 step-through-only controls ──

  it("shows step-through controls only — no play/pause, no scrubber", () => {
    const { container } = render(<TracePlayer factory={arrayTrace} renderers={{ array: ArrayView }} controls />);
    expect(screen.getByLabelText("Step back")).toBeTruthy();
    expect(screen.getByLabelText("Step forward")).toBeTruthy();
    expect(screen.queryByLabelText("Play")).toBeNull();
    expect(screen.queryByLabelText("Pause")).toBeNull();
    expect(screen.queryByLabelText("Scrub")).toBeNull();
    expect(container.querySelector(".trace-scrubber")).toBeNull();
  });

  it("step forward wraps to the start at the end (infinite stepping)", () => {
    render(<TracePlayer factory={arrayTrace} renderers={{ array: ArrayView }} loop />);
    const fwd = () => fireEvent.click(screen.getByLabelText("Step forward"));
    fwd();
    expect(screen.getByTestId("array-view").textContent).toBe("0,1");
    fwd();
    expect(screen.getByTestId("array-view").textContent).toBe("0,1,2"); // last frame
    fwd();
    expect(screen.getByTestId("array-view").textContent).toBe("0"); // wrapped back to the start
    // …and the wrap is not a one-off: stepping keeps working around the loop. This guards the #3390 shape
    // of the bug specifically — the wrap used to cost a DEAD CLICK (the first click on the last frame did
    // nothing because `atEnd()` still read false), so an off-by-one here is visible as a stalled step.
    fwd();
    expect(screen.getByTestId("array-view").textContent).toBe("0,1");
    fwd();
    expect(screen.getByTestId("array-view").textContent).toBe("0,1,2");
    fwd();
    expect(screen.getByTestId("array-view").textContent).toBe("0"); // wraps again, every lap
  });

  it("stepping pauses the infinite loop, which auto-resumes after idle", () => {
    vi.useFakeTimers();
    try {
      render(<TracePlayer factory={arrayTrace} renderers={{ array: ArrayView }} autoPlay loop fps={10} />);
      act(() => void vi.advanceTimersByTime(100)); // auto-playing → "0,1"
      expect(screen.getByTestId("array-view").textContent).toBe("0,1");
      // Step back → pauses; the loop no longer advances on its beat.
      act(() => void fireEvent.click(screen.getByLabelText("Step back")));
      const paused = screen.getByTestId("array-view").textContent; // "0"
      act(() => void vi.advanceTimersByTime(100));
      expect(screen.getByTestId("array-view").textContent).toBe(paused); // still paused
      // After the idle window (RESUME_MS = 2500), the loop resumes and advances again.
      act(() => void vi.advanceTimersByTime(2500));
      act(() => void vi.advanceTimersByTime(100));
      expect(screen.getByTestId("array-view").textContent).not.toBe(paused);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The code column (#3250) — the animation paired with its source. The player already owns the frame
// cursor, so the highlight is driven from the SAME state as the picture; these assert they move together.
describe("TracePlayer source column (#3250)", () => {
  const SRC = `({ run(a) { a.compare(0, 1); a.swap(0, 1); } })`;
  const range = (text: string) => ({ start: SRC.indexOf(text), end: SRC.indexOf(text) + text.length, line: 1 });

  /** Three beats: at-rest (no provenance), then a compare, then a swap. */
  const locTrace = (): Generator<Frame> =>
    (function* () {
      yield { structure: "array", data: [1, 0] };
      yield { structure: "array", data: [1, 0], loc: range("a.compare(0, 1)") };
      yield { structure: "array", data: [0, 1], loc: range("a.swap(0, 1)") };
    })();

  /** The currently highlighted span, or null when nothing is lit. */
  const litSpan = () => document.querySelector("[data-op-span]")?.textContent ?? null;

  it("renders no code column when no source is given (the inline preview is unchanged)", () => {
    render(<TracePlayer factory={locTrace} renderers={{ array: ArrayView }} />);
    expect(screen.queryByLabelText("Trace-program source")).toBeNull();
  });

  it("renders the source column when given one", () => {
    render(<TracePlayer factory={locTrace} renderers={{ array: ArrayView }} source={SRC} />);
    expect(screen.getByLabelText("Trace-program source").textContent).toBe(SRC);
  });

  it("moves the highlight to the executing op on every beat", () => {
    render(<TracePlayer factory={locTrace} renderers={{ array: ArrayView }} source={SRC} />);
    // Beat 0 is the array at rest — it precedes any op, so nothing is lit.
    expect(litSpan()).toBeNull();

    fireEvent.click(screen.getByLabelText("Step forward"));
    expect(litSpan()).toBe("a.compare(0, 1)");
    expect(screen.getByTestId("array-view").textContent).toBe("1,0"); // picture + code in step

    fireEvent.click(screen.getByLabelText("Step forward"));
    expect(litSpan()).toBe("a.swap(0, 1)");
    expect(screen.getByTestId("array-view").textContent).toBe("0,1");

    // Stepping BACK rewinds the highlight too — it tracks the cursor, not a monotonic counter.
    fireEvent.click(screen.getByLabelText("Step back"));
    expect(litSpan()).toBe("a.compare(0, 1)");
  });
});
