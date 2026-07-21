// DashboardPage (#2505) — the metrics-board page composition: StatCard KPI grid (inline Spark
// trends), the LineArea trend + Donut/Legend breakdown cards, and the ActivityFeed column, all
// rendered from typed inputs; every region is droppable.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DashboardPage, type DashboardStat } from "./DashboardPage";

const STATS: DashboardStat[] = [
  { k: "landed", v: 12, tone: "success", trend: [3, 5, 4, 8, 12] },
  { k: "blocked", v: 1, tone: "danger", sub: "1 waiting" },
];
const TREND = {
  title: "Throughput", hint: "7d", labels: ["m", "t", "w"],
  series: [{ name: "landed", color: "var(--success)", data: [3, 5, 4] }],
};
const BREAKDOWN = {
  title: "By state",
  slices: [{ name: "landed", value: 12, color: "var(--success)" }, { name: "open", value: 4, color: "var(--accent)" }],
};
const ACTIVITY = {
  hint: "all repos",
  items: [{ login: "kevin", action: "merged", target: "#2504", repo: "bsc", createdAt: new Date().toISOString() }],
  tone: { merged: "var(--success)" },
};

describe("DashboardPage — rendering from typed inputs", () => {
  it("renders the header bar, one StatCard per stat, and an inline Spark for a stat with a trend", () => {
    const { container } = render(<DashboardPage title="Fleet" hint="7d" stats={STATS} />);
    expect(screen.getByText("Fleet")).toBeInTheDocument();
    expect(container.querySelectorAll(".statcard")).toHaveLength(2);
    expect(screen.getByText("landed")).toBeInTheDocument();
    expect(screen.getByText("1 waiting")).toBeInTheDocument();
    expect(container.querySelector(".statcard svg"), "trend stat renders a Spark").toBeTruthy();
  });

  it("renders the trend card (LineArea), the breakdown card (Donut + Legend), and the activity feed", () => {
    const { container } = render(
      <DashboardPage title="Fleet" stats={STATS} trend={TREND} breakdown={BREAKDOWN} activity={ACTIVITY} />,
    );
    expect(screen.getByText("Throughput")).toBeInTheDocument();
    expect(screen.getByText("By state")).toBeInTheDocument();
    expect(screen.getAllByText("landed").length).toBeGreaterThan(1); // stat + legend
    expect(screen.getByText("Recent activity")).toBeInTheDocument();
    expect(screen.getByText("#2504")).toBeInTheDocument();
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3); // spark + line + donut
  });

  it("drops the chart/activity regions cleanly when their inputs are omitted", () => {
    render(<DashboardPage title="Fleet" stats={STATS} />);
    expect(screen.queryByText("Throughput")).toBeNull();
    expect(screen.queryByText("Recent activity")).toBeNull();
  });

  it("renders the charts without the activity column (no orphan grid)", () => {
    render(<DashboardPage title="Fleet" stats={[]} trend={TREND} />);
    expect(screen.getByText("Throughput")).toBeInTheDocument();
    expect(screen.queryByText("Recent activity")).toBeNull();
  });
});
