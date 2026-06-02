import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Fleet } from "../screens/projects/Fleet";
import { WORKERS, MERGE_QUEUE, FLEET_KPIS, statusCounts, rangeSlice } from "../data/fleet";

describe("Fleet screen", () => {
  it("renders the header, KPI row, worker board, and director queue", () => {
    render(<Fleet />);
    expect(screen.getByRole("heading", { name: "Fleet" })).toBeTruthy();
    // KPI labels
    expect(screen.getByText("active workers")).toBeTruthy();
    expect(screen.getByText("need attention")).toBeTruthy();
    // Worker board rows (one per worker)
    for (const w of WORKERS) expect(screen.getAllByText(w.id).length).toBeGreaterThan(0);
    // Director merge queue PRs
    for (const q of MERGE_QUEUE) expect(screen.getByText(q.pr)).toBeTruthy();
    // Panels present
    expect(screen.getByText("Worker board")).toBeTruthy();
    expect(screen.getByText("Fleet status")).toBeTruthy();
    expect(screen.getByText("Fleet throughput")).toBeTruthy();
  });

  it("range toggle switches the throughput window (7d / 14d)", () => {
    const { container } = render(<Fleet />);
    const seg = container.querySelector(".seg") as HTMLElement;
    const get = (label: string) => within(seg).getByText(label);
    // Default is 14d.
    expect(get("14d").className).toContain("on");
    expect(get("7d").className).not.toContain("on");
    fireEvent.click(get("7d"));
    expect(get("7d").className).toContain("on");
    expect(get("14d").className).not.toContain("on");
  });
});

describe("fleet data", () => {
  it("statusCounts tallies workers by status", () => {
    const c = statusCounts();
    const total = Object.values(c).reduce((a, n) => a + (n ?? 0), 0);
    expect(total).toBe(WORKERS.length);
    expect(c.running).toBe(WORKERS.filter(w => w.status === "running").length);
  });

  it("rangeSlice returns 7 or 14 aligned points", () => {
    const d7 = rangeSlice("7d");
    expect(d7.labels).toHaveLength(7);
    expect(d7.landed).toHaveLength(7);
    expect(d7.merged).toHaveLength(7);
    expect(rangeSlice("14d").labels).toHaveLength(14);
  });

  it("KPIs are internally consistent with the worker list", () => {
    expect(FLEET_KPIS.totalWorkers).toBe(WORKERS.length);
    expect(FLEET_KPIS.activeWorkers).toBe(WORKERS.filter(w => w.status === "running").length);
  });
});
