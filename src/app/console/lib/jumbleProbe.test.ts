import { describe, it, expect } from "vitest";
import { probeJumble } from "./jumbleProbe";

const box = (cols: number) => "╭" + "─".repeat(cols - 2) + "╮";
const boxBottom = (cols: number) => "╰" + "─".repeat(cols - 2) + "╯";

describe("jumbleProbe — probeJumble (#1250)", () => {
  it("a clean input box with a full-width border is healthy", () => {
    const rows = [box(44), "│ > tell me a joke".padEnd(43) + "│", boxBottom(44)];
    expect(probeJumble(rows, 44)).toBe("healthy");
  });

  it("box chrome present but the border is shattered is malformed", () => {
    // Box-drawing characters appear, but no long contiguous horizontal run (cells overwritten/shifted).
    const rows = ["╭─╮ x ╰foo─╯ │ ┐", "│hi│  ─ ╮╭ bar ┘─│", "garbled ╰─ ┐│ ╮"];
    expect(probeJumble(rows, 44)).toBe("malformed");
  });

  it("plain output with no box chrome is unknown (never nudge)", () => {
    expect(probeJumble(["Running tests…", "PASS  3 passed", "$ "], 80)).toBe("unknown");
  });

  it("guards empty input and a zero-width grid", () => {
    expect(probeJumble([], 80)).toBe("unknown");
    expect(probeJumble([box(40)], 0)).toBe("unknown");
  });

  it("scales the healthy threshold to the pane width (narrow pane)", () => {
    // cols=10 → healthy border needs ≥8 horizontal chars; a clean 10-wide box clears it.
    expect(probeJumble([box(10), boxBottom(10)], 10)).toBe("healthy");
    // a stray short run of box chars on a narrow pane is still malformed
    expect(probeJumble(["╭─╮ ╰╯ │", "┐ ─ ╮"], 10)).toBe("malformed");
  });
});
