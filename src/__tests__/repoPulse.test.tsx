import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Pulse } from "../screens/github/Pulse";
import { REPO, BRANCHES, WORKFLOWS, vrange } from "../data/repoPulse";

describe("Pulse screen", () => {
  it("renders the header, KPI row, and all analytics panels", () => {
    render(<Pulse />);
    expect(screen.getByRole("heading", { name: "Pulse" })).toBeTruthy();
    expect(screen.getByText(REPO.name)).toBeTruthy();
    // KPI labels
    expect(screen.getByText("commits · 7d")).toBeTruthy();
    expect(screen.getByText("agent commits")).toBeTruthy();
    // Panels
    for (const title of ["Commit & PR velocity", "Lines changed", "Churn by area", "Hottest files",
      "CI health", "Contributors", "Active branches", "Review latency"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    // Contributor + branch + workflow rows render.
    expect(screen.getAllByText("kevinthelago").length).toBeGreaterThan(0);
    for (const b of BRANCHES) expect(screen.getByText(b.n)).toBeTruthy();
    // release.yml also appears in the digest, so allow >1.
    for (const w of WORKFLOWS) expect(screen.getAllByText(w.name).length).toBeGreaterThan(0);
    // Contributors are distinguished as agent vs human (both kinds present).
    const { container } = render(<Pulse />);
    const tagText = Array.from(container.querySelectorAll(".tag")).map(t => t.textContent);
    expect(tagText).toContain("agent");
    expect(tagText).toContain("human");
  });

  it("velocity range toggle switches 14d ↔ 7d", () => {
    const { container } = render(<Pulse />);
    // First .seg is the velocity card's range toggle.
    const seg = container.querySelector(".seg") as HTMLElement;
    const get = (label: string) => within(seg).getByText(label);
    expect(get("14d").className).toContain("on");
    fireEvent.click(get("7d"));
    expect(get("7d").className).toContain("on");
    expect(get("14d").className).not.toContain("on");
  });
});

describe("repoPulse data", () => {
  it("vrange returns 7 or 14 aligned points across every series", () => {
    const d7 = vrange("7d");
    for (const arr of [d7.labels, d7.commits, d7.merged, d7.opened, d7.adds, d7.dels]) {
      expect(arr).toHaveLength(7);
    }
    expect(vrange("14d").commits).toHaveLength(14);
  });
});
