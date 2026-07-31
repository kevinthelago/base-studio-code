import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlancePlanScreen, planScreenIssues, progressLabel } from "./GlancePlanScreen";

describe("planScreenIssues", () => {
  it("keeps PLAN order rather than sorting by state", () => {
    // The plan sequences a worker's work; re-sorting done-first would quietly hide that sequence.
    const out = planScreenIssues(["#3", "#1", "#2"], new Map([["1", true]]));
    expect(out.map((i) => i.ref)).toEqual(["#3", "#1", "#2"]);
  });

  it("distinguishes closed, open and UNRESOLVED", () => {
    // Three states that must stay distinct — rendering "unknown" as open would be confidently wrong.
    const out = planScreenIssues(["#1", "#2", "#3"], new Map([["1", true], ["2", false]]));
    expect(out).toEqual([
      { ref: "#1", closed: true },
      { ref: "#2", closed: false },
      { ref: "#3", closed: undefined },
    ]);
  });

  it("shows a ref listed twice once", () => {
    expect(planScreenIssues(["#1", "#1"], new Map()).length).toBe(1);
  });
});

describe("progressLabel", () => {
  it("reads as done/total, and is blank when nothing is owned", () => {
    expect(progressLabel({ done: 3, total: 7 })).toBe("3/7");
    expect(progressLabel({ done: 0, total: 0 })).toBe("");
    expect(progressLabel(undefined)).toBe("");
  });
});

describe("GlancePlanScreen", () => {
  it("lists the worker's issues with their state", () => {
    render(
      <GlancePlanScreen
        issues={[{ ref: "#3871", closed: true }, { ref: "#3992", closed: false }]}
        progress={{ done: 1, total: 2 }}
      />,
    );
    expect(screen.getByText("#3871")).toBeTruthy();
    expect(screen.getByText("closed")).toBeTruthy();
    expect(screen.getByText("#3992")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("NEVER token-gates the list — with no GitHub the issues still render (#2444)", () => {
    // The regression that matters most: ownership is local, so a disconnected user must still see
    // exactly which issues are theirs. Only the state chips degrade.
    render(<GlancePlanScreen issues={[{ ref: "#3871" }, { ref: "#3992" }]} unresolved />);
    expect(screen.getByText("#3871")).toBeTruthy();
    expect(screen.getByText("#3992")).toBeTruthy();
    expect(screen.getAllByText("state unknown").length).toBe(2);
    expect(screen.getByText(/Connect GitHub/)).toBeTruthy();
  });

  it("says 'checking' rather than 'unknown' while the overlay is in flight", () => {
    render(<GlancePlanScreen issues={[{ ref: "#1" }]} loading />);
    expect(screen.getByText("checking…")).toBeTruthy();
  });

  it("explains a worker that owns nothing instead of rendering an empty list", () => {
    render(<GlancePlanScreen issues={[]} />);
    expect(screen.getByText(/owns no issues in the plan/)).toBeTruthy();
  });
});
