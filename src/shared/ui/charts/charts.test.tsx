import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { LineArea, Bars, Donut, HBars, Swimlane, Spark, Legend, StatCard, fmt } from "./";

describe("chart primitives smoke", () => {
  it("LineArea renders an svg with a path per series", () => {
    const { container } = render(
      <LineArea labels={["a", "b", "c"]} series={[
        { name: "x", color: "var(--accent)", data: [1, 2, 3] },
        { name: "y", color: "var(--success)", data: [3, 2, 1] },
      ]} />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // 2 series → at least 2 stroked line paths.
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
  });

  it("Bars renders a rect per bar", () => {
    const { container } = render(
      <Bars labels={["a", "b"]} groups={[{ name: "g", color: "var(--accent)", data: [2, 5] }]} />,
    );
    expect(container.querySelectorAll("rect").length).toBe(2);
  });

  it("Donut renders the track + one arc per slice and the center label", () => {
    const { container } = render(
      <Donut slices={[{ name: "a", value: 3, color: "var(--accent)" }, { name: "b", value: 1, color: "var(--info)" }]}
        center={{ value: 4, label: "workers" }} />,
    );
    // 1 background track + 2 slice arcs.
    expect(container.querySelectorAll("circle").length).toBe(3);
    expect(container.textContent).toContain("workers");
  });

  it("HBars renders a labeled meter per row", () => {
    const { container } = render(
      <HBars rows={[{ label: "api", value: 10 }, { label: "docs", value: 4 }]} fmtV={(v) => `${v}k`} />,
    );
    expect(container.querySelectorAll(".meter").length).toBe(2);
    expect(container.textContent).toContain("10k");
  });

  it("Swimlane, Spark, Legend, StatCard render without crashing", () => {
    const sl = render(<Swimlane lanes={[{ name: "a" }]} events={[{ lane: 0, t0: 0.1, t1: 0.5, color: "var(--accent)", label: "e" }]} />);
    expect(sl.container.querySelector("svg")).toBeTruthy();
    const sp = render(<Spark data={[1, 3, 2, 5]} color="var(--accent)" />);
    expect(sp.container.querySelector("svg")).toBeTruthy();
    const lg = render(<Legend items={[{ color: "var(--accent)", label: "landed" }]} />);
    expect(lg.container.textContent).toContain("landed");
    const sc = render(<StatCard k="spend" v="$6.32" sub="today" tone="success" />);
    expect(sc.container.textContent).toContain("$6.32");
  });

  it("fmt compacts thousands", () => {
    expect(fmt(950)).toBe("950");
    expect(fmt(1500)).toBe("1.5k");
    expect(fmt(12000)).toBe("12k");
  });
});
