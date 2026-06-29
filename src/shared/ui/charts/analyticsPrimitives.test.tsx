import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatCard, StackedDayBars, type StackedDay } from "./index";

describe("StatCard", () => {
  it("renders label (k), value (v) and sub", () => {
    render(<StatCard k="Total calls" v={42} sub="last 14 days" />);
    expect(screen.getByText("Total calls")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("last 14 days")).toBeTruthy();
  });

  it("colors the value from `tone`", () => {
    render(<StatCard k="Errors" v={3} sub="failed" tone="danger" />);
    expect((screen.getByText("3") as HTMLElement).style.color).toBe("var(--danger)");
  });
});

describe("StackedDayBars", () => {
  const data: StackedDay[] = [
    { day: "2026-06-01", upper: 4, lower: 1 },
    { day: "2026-06-02", upper: 0, lower: 0 },
    { day: "2026-06-03", upper: 2, lower: 3 },
    { day: "2026-06-04", upper: 5, lower: 0 },
  ];

  it("renders title, subtitle and both legend labels", () => {
    render(<StackedDayBars data={data} title="Calls over time" subtitle="daily · ok vs error" upperLabel="ok" lowerLabel="error" />);
    expect(screen.getByText("Calls over time")).toBeTruthy();
    expect(screen.getByText("daily · ok vs error")).toBeTruthy();
    expect(screen.getByText("ok")).toBeTruthy();
    expect(screen.getByText("error")).toBeTruthy();
  });

  it("draws a bar rect only for non-zero segments", () => {
    const { container } = render(
      <StackedDayBars data={data} title="t" subtitle="s" upperLabel="u" lowerLabel="l" />,
    );
    // day1: upper+lower (2 rects), day2: 0 (0), day3: 2 rects, day4: upper only (1) = 5 bar rects.
    // gridVals contribute <line>s + <text>s, not <rect>s, so rect count == bar segments.
    expect(container.querySelectorAll("rect").length).toBe(5);
  });

  it("renders every 3rd day label (slice(5))", () => {
    render(<StackedDayBars data={data} title="t" subtitle="s" upperLabel="u" lowerLabel="l" />);
    expect(screen.getByText("06-01")).toBeTruthy(); // i=0 shown
    expect(screen.getByText("06-04")).toBeTruthy(); // i=3 shown
    expect(screen.queryByText("06-02")).toBeNull(); // i=1 hidden
  });

  it("renders cleanly with empty data", () => {
    const { container } = render(
      <StackedDayBars data={[]} title="t" subtitle="s" upperLabel="u" lowerLabel="l" />,
    );
    expect(container.querySelectorAll("rect").length).toBe(0);
    expect(container.querySelector("svg")).toBeTruthy();
  });
});
