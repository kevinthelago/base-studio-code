import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StackView } from "./StackView";
import type { StackFrame } from "../../lib/trace";

const frame = (over: Partial<StackFrame>): StackFrame => ({ structure: "stack", data: [1, 2, 3], ...over });

describe("StackView (#3266)", () => {
  it("renders a cell per entry + a mode badge", () => {
    const { container } = render(<StackView frame={frame({ mode: "queue" })} />);
    expect(container.querySelectorAll(".stack-cell").length).toBe(3);
    expect(screen.getByText(/queue/)).toBeInTheDocument();
  });

  it("stamps push on the BACK/top cell and pop on the FRONT cell for a queue", () => {
    // push → the last entry (3) is the newly-enqueued back.
    const pushed = render(<StackView frame={frame({ mode: "queue", ops: [{ op: "push" }] })} />).container;
    expect(pushed.querySelector('.stack-cell[data-op="push"]')?.textContent).toBe("3");
    // pop (queue) → the FRONT entry (1) is the one leaving.
    const popped = render(<StackView frame={frame({ mode: "queue", ops: [{ op: "pop" }] })} />).container;
    expect(popped.querySelector('.stack-cell[data-op="pop"]')?.textContent).toBe("1");
  });

  it("a STACK pops the TOP (last) entry, not the front", () => {
    const c = render(<StackView frame={frame({ mode: "stack", ops: [{ op: "pop" }] })} />).container;
    expect(c.querySelector('.stack-cell[data-op="pop"]')?.textContent).toBe("3"); // top out
  });

  it("stamps peek on the inspected index", () => {
    const c = render(<StackView frame={frame({ ops: [{ op: "peek", at: 1 }] })} />).container;
    expect(c.querySelector('.stack-cell[data-op="peek"]')?.textContent).toBe("2");
  });

  it("shows an empty state when the structure has drained", () => {
    render(<StackView frame={frame({ data: [] })} />);
    expect(screen.getByText("(empty)")).toBeInTheDocument();
  });
});
