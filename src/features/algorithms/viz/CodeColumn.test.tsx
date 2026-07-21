// The per-op source-highlight column (#3250) — the pure split model plus a render smoke test.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CodeColumn, splitAtLoc } from "./CodeColumn";

const SRC = `({ run(a) { a.compare(0, 1); a.swap(0, 1); } })`;
/** The range of `a.swap(0, 1)` in SRC. */
const SWAP = { start: SRC.indexOf("a.swap(0, 1)"), end: SRC.indexOf("a.swap(0, 1)") + "a.swap(0, 1)".length, line: 1 };

describe("splitAtLoc (#3250)", () => {
  it("splits the source around the op's range", () => {
    const { before, hit, after } = splitAtLoc(SRC, SWAP);
    expect(hit).toBe("a.swap(0, 1)");
    expect(before + hit + after).toBe(SRC); // lossless — the column always shows the whole program
  });

  it("highlights nothing for a frame with no location", () => {
    expect(splitAtLoc(SRC, undefined)).toEqual({ before: SRC, hit: "", after: "" });
  });

  it("clamps an out-of-bounds range instead of throwing", () => {
    const { before, hit, after } = splitAtLoc("abc", { start: 2, end: 999, line: 1 });
    expect({ before, hit, after }).toEqual({ before: "ab", hit: "c", after: "" });
  });

  it("discards an inverted or empty range", () => {
    expect(splitAtLoc("abc", { start: 2, end: 1, line: 1 }).hit).toBe("");
    expect(splitAtLoc("abc", { start: 1, end: 1, line: 1 }).hit).toBe("");
  });
});

describe("CodeColumn (#3250)", () => {
  it("renders the whole program and marks the executing op", () => {
    render(<CodeColumn source={SRC} loc={SWAP} />);
    const mark = document.querySelector("[data-op-span]");
    expect(mark?.textContent).toBe("a.swap(0, 1)");
    // The rest of the program is still on screen — the column shows context, not just the one call.
    expect(screen.getByLabelText("Trace-program source").textContent).toBe(SRC);
  });

  it("shows the 1-based line readout for the executing op", () => {
    render(<CodeColumn source={"({\n  run(a) { a.swap(0, 1); }\n})"} loc={{ start: 13, end: 25, line: 2 }} />);
    expect(screen.getByText("line 2")).toBeTruthy();
  });

  it("renders the source with nothing marked when the frame has no location", () => {
    render(<CodeColumn source={SRC} />);
    expect(document.querySelector("[data-op-span]")).toBeNull();
    expect(screen.getByLabelText("Trace-program source").textContent).toBe(SRC);
  });
});
