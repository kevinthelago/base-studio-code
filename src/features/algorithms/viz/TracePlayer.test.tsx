// The generic trace player (#3176) — render smoke: it renders the registered renderer for a structure,
// falls back (JSON dump) for an unregistered one, lays out multi-structure panels, and step-forward
// advances the frame.
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
});
