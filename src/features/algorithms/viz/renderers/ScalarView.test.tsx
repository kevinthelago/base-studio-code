import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScalarView } from "./ScalarView";
import type { ScalarFrame } from "../../lib/trace";

const frame = (over: Partial<ScalarFrame>): ScalarFrame => ({
  structure: "scalar",
  values: { settled: 2, current: "c" },
  ...over,
});

describe("ScalarView (#3268)", () => {
  it("renders a chip per variable, each showing its name + value", () => {
    const { container } = render(<ScalarView frame={frame({})} />);
    expect(container.querySelectorAll(".scalar-chip").length).toBe(2);
    expect(screen.getByText("settled")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("current")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
  });

  it("stamps data-op on the touched variable's chip (keyed by NAME)", () => {
    const c = render(
      <ScalarView frame={frame({ ops: { settled: { op: "add", delta: 1 } } })} />,
    ).container;
    const chip = c.querySelector('.scalar-chip[data-op="add"]');
    expect(chip?.getAttribute("aria-label")).toBe("settled"); // the ADD chip is `settled`, not `current`
    expect(c.querySelector('.scalar-chip[data-op="add"][aria-label="current"]')).toBeNull();
  });

  it("stamps set / compare on their respective variables", () => {
    const c = render(
      <ScalarView frame={frame({ ops: { current: { op: "set" }, settled: { op: "compare", other: 3 } } })} />,
    ).container;
    expect(c.querySelector('.scalar-chip[data-op="set"]')?.getAttribute("aria-label")).toBe("current");
    expect(c.querySelector('.scalar-chip[data-op="compare"]')?.getAttribute("aria-label")).toBe("settled");
  });

  it("renders variables in a stable (name-sorted) order", () => {
    const { container } = render(<ScalarView frame={frame({ values: { z: 1, a: 2, m: 3 } })} />);
    const labels = [...container.querySelectorAll(".scalar-chip")].map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["a", "m", "z"]);
  });

  it("shows an empty state when there are no variables", () => {
    render(<ScalarView frame={frame({ values: {} })} />);
    expect(screen.getByText("(no variables)")).toBeInTheDocument();
  });
});
