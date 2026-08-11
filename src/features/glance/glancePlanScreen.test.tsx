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

  // ── plan.db as the primary source ────────────────────────────────────────────
  it("resolves every row from plan.db with NO GitHub overlay at all", () => {
    // The local-first case: a project that never touches GitHub. Before this, every row read
    // "state unknown" while plan.db knew each status exactly.
    const out = planScreenIssues(
      ["4260-sandbox", "4251-hash-seed"],
      new Map(),
      new Map([["4260-sandbox", true], ["4251-hash-seed", false]]),
    );
    expect(out).toEqual([
      { ref: "4260-sandbox", closed: true },
      { ref: "4251-hash-seed", closed: false },
    ]);
  });

  it("prefers plan.db over the GitHub overlay when they disagree", () => {
    // plan.db is the store of record. GitHub can be stale — here it still calls the issue open.
    const out = planScreenIssues(["#1"], new Map([["1", false]]), new Map([["#1", true]]));
    expect(out[0].closed).toBe(true);
  });

  it("falls back to the overlay for a ref plan.db has never heard of", () => {
    const out = planScreenIssues(["#1", "#2"], new Map([["2", true]]), new Map([["#1", false]]));
    expect(out).toEqual([
      { ref: "#1", closed: false },  // plan.db
      { ref: "#2", closed: true },   // overlay filled the gap
    ]);
  });

  it("matches a plan.db ref by its raw OR normalised spelling", () => {
    // plan.db stores refs verbatim — `#3898` in an older plan, `4260-slug` in a migrated one — while
    // the overlay is keyed by the bare number. Checking one spelling only would miss the other.
    expect(planScreenIssues(["#3898"], new Map(), new Map([["3898", true]]))[0].closed).toBe(true);
    expect(planScreenIssues(["#3898"], new Map(), new Map([["#3898", true]]))[0].closed).toBe(true);
  });

  it("does not treat a known-open plan.db row as unknown", () => {
    // `false` and `undefined` must stay distinct: one is a state, the other is the absence of one,
    // and only the second should ever prompt "connect GitHub".
    const out = planScreenIssues(["#1"], new Map(), new Map([["#1", false]]));
    expect(out[0].closed).toBe(false);
    expect(out[0].closed).not.toBeUndefined();
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

  it("does NOT ask for GitHub when plan.db already answered every row", () => {
    // A local-first project resolves every state from plan.db, so the overlay being unavailable costs
    // nothing. Telling that user to connect GitHub would be advice to fix a problem they do not have.
    render(
      <GlancePlanScreen
        issues={[{ ref: "4260-sandbox", closed: true }, { ref: "4251-hash", closed: false }]}
        progress={{ done: 1, total: 2 }}
        unresolved
      />,
    );
    expect(screen.getByText("closed")).toBeTruthy();
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.queryByText("state unknown")).toBeNull();
    expect(screen.queryByText(/Connect GitHub/)).toBeNull();
  });

  it("still asks for GitHub when SOME row is unresolved after plan.db", () => {
    // Partial coverage: plan.db knows one, nothing knows the other. The note earns its place here.
    render(
      <GlancePlanScreen issues={[{ ref: "#1", closed: true }, { ref: "#2" }]} unresolved />,
    );
    expect(screen.getByText("state unknown")).toBeTruthy();
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
