// The <ArrayView> renderer (#3178) — it stamps the right data-op / data-mark on the cells an op targets
// (via opStateAttrs), renders the values, draws the frame's cursors as labeled pills, and binds the
// data-defined kit motion (#2942) — its root carries the applying classes + it injects the compiled CSS.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ArrayView } from "./ArrayView";
import { ALGO_VIZ_ANIM_CLASSES, ALGO_VIZ_MOTION_CSS } from "./arrayViewMotion";
import type { ArrayFrame } from "../../lib/trace";
import { TracedArray } from "../../lib/tracer";
import { binarySearch } from "../examples/searches";

/** Render an ArrayFrame and return its cell elements (in index order) + the container. */
function renderFrame(frame: ArrayFrame) {
  const { container } = render(<ArrayView frame={frame} />);
  const cells = Array.from(container.querySelectorAll<HTMLElement>(".array-cell"));
  return { container, cells };
}

describe("ArrayView (#3178)", () => {
  it("binds the data-defined kit motion: root carries the applying classes + injects the compiled CSS", () => {
    document.getElementById("bsc-algo-viz-animations")?.remove();
    const { container } = render(<ArrayView frame={{ structure: "array", data: [1, 2] }} />);
    // The renderer BINDS the kit animations the standard way — its root wears the applying classes.
    const root = container.querySelector<HTMLElement>(".array-view")!;
    for (const cls of ALGO_VIZ_ANIM_CLASSES.split(" ")) expect(root.classList.contains(cls)).toBe(true);
    // …and it ensures the engine-compiled kit motion CSS is present (state-triggered on the data-states).
    const style = document.getElementById("bsc-algo-viz-animations");
    expect(style?.textContent).toBe(ALGO_VIZ_MOTION_CSS);
  });

  it("renders one cell per value, showing the value", () => {
    const { cells } = renderFrame({ structure: "array", data: [5, 1, 3] });
    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c.querySelector(".array-val")?.textContent)).toEqual(["5", "1", "3"]);
  });

  it("stamps data-op='compare' on BOTH cells a compare op spans", () => {
    const { cells } = renderFrame({ structure: "array", data: [5, 1, 3], ops: [{ op: "compare", at: [0, 1] }] });
    expect(cells[0].getAttribute("data-op")).toBe("compare");
    expect(cells[1].getAttribute("data-op")).toBe("compare");
    expect(cells[2].hasAttribute("data-op")).toBe(false);
  });

  it("stamps data-op='swap' on the swapped pair", () => {
    const { cells } = renderFrame({ structure: "array", data: [1, 3, 2], ops: [{ op: "swap", at: [1, 2] }] });
    expect(cells[1].getAttribute("data-op")).toBe("swap");
    expect(cells[2].getAttribute("data-op")).toBe("swap");
    expect(cells[0].hasAttribute("data-op")).toBe(false);
  });

  it("stamps data-op='set' on the single set index", () => {
    const { cells } = renderFrame({ structure: "array", data: [1, 9, 2], ops: [{ op: "set", at: 1 }] });
    expect(cells[1].getAttribute("data-op")).toBe("set");
    expect(cells[0].hasAttribute("data-op")).toBe(false);
  });

  it("stamps data-mark from a mark op (not data-op)", () => {
    const { cells } = renderFrame({
      structure: "array",
      data: [1, 2, 3],
      ops: [
        { op: "mark", at: 0, as: "sorted" },
        { op: "mark", at: 2, as: "pivot" },
      ],
    });
    expect(cells[0].getAttribute("data-mark")).toBe("sorted");
    expect(cells[0].hasAttribute("data-op")).toBe(false);
    expect(cells[2].getAttribute("data-mark")).toBe("pivot");
    expect(cells[1].hasAttribute("data-mark")).toBe(false);
  });

  it("renders a REAL search trace end to end: probes stamp data-op, the hit stamps data-mark='found'", () => {
    // Instrumented execution all the way through (#3220) — the actual binary search drives the render.
    const a = new TracedArray([1, 3, 4, 7, 9]);
    binarySearch(a, 9);
    const frames = a.trace();
    const probed = frames.filter((f) => f.ops?.some((o) => o.op === "probe"));
    expect(probed.length).toBeGreaterThan(0);
    for (const f of probed) {
      const at = (f.ops!.find((o) => o.op === "probe") as { at: number }).at;
      const { cells } = renderFrame(f);
      expect(cells[at].getAttribute("data-op")).toBe("probe");
      // A probe examines exactly ONE cell — no pairwise highlight (that is `compare`'s job).
      expect(cells.filter((c) => c.getAttribute("data-op") === "probe")).toHaveLength(1);
    }
    // The terminal frame paints the hit durably — the visible answer the whole search was for.
    const { cells } = renderFrame(frames[frames.length - 1]);
    expect(cells[4].getAttribute("data-mark")).toBe("found");
    expect(cells.filter((c) => c.hasAttribute("data-mark"))).toHaveLength(1);
  });

  it("renders cursors as labeled pills above their index", () => {
    const { container } = renderFrame({ structure: "array", data: [5, 1, 3, 8], cursors: { i: 1, j: 3 } });
    const cols = Array.from(container.querySelectorAll<HTMLElement>(".array-col"));
    // The pill labels present anywhere.
    const pills = Array.from(container.querySelectorAll<HTMLElement>(".array-cursor-pill")).map((p) => p.textContent);
    expect(pills.sort()).toEqual(["i", "j"]);
    // The `i` pill sits over index 1, the `j` pill over index 3.
    expect(cols[1].querySelector(".array-cursor-pill")?.textContent).toBe("i");
    expect(cols[3].querySelector(".array-cursor-pill")?.textContent).toBe("j");
    expect(cols[0].querySelector(".array-cursor-pill")).toBeNull();
  });

  it("stacks multiple cursors that share an index", () => {
    const { container } = renderFrame({ structure: "array", data: [5, 1], cursors: { i: 1, j: 1 } });
    const cols = Array.from(container.querySelectorAll<HTMLElement>(".array-col"));
    const pills = Array.from(cols[1].querySelectorAll<HTMLElement>(".array-cursor-pill")).map((p) => p.textContent);
    expect(pills).toEqual(["i", "j"]);
  });
});
