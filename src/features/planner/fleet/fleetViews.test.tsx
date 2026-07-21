// Render tests for the Fleet page's extracted pure views (#3481).
//
// These exist BECAUSE of the host/tree split: before it, testing this markup meant mocking a store
// read, a coordination poll, and a `bsc` CLI call just to assert an empty state. Now each view is a
// function of its props, so the interesting cases — loading vs genuinely-empty vs populated, and the
// truncation boundaries — are directly reachable. That testability is a large part of the point.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FleetLessonsView } from "./FleetLessons";
import { CostEnergyView } from "./CostEnergy";
import { FleetHealthView } from "./FleetHealth";
import type { FleetCost } from "./lib/fleetCost";
import type { FleetHealth as FleetHealthData } from "./lib/fleetHealth";
import type { Lesson } from "@/features/skills";

// NO `as Lesson` cast here, deliberately: the first draft of this fixture cast an incomplete object
// and the cast silenced the missing `rule`, which `lessonTitle` dereferences — the tests failed at
// runtime for a reason the type checker should have caught. A fully-typed fixture cannot drift.
const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({
  id,
  mistake: `mistake ${id}`,
  cause: "",
  // A distinct rule, because `lessonTitle` falls back to `mistake` when `rule` is blank — with both
  // blank the title and the mistake line render the SAME string, which is not what real data looks
  // like and makes every text assertion ambiguous.
  rule: `rule ${id}`,
  provenance: "worker/api",
  status: "pending",
  seen: 1,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const emptyCost: FleetCost = {
  workers: [], totalTokens: 0, totalInput: 0, totalOutput: 0, totalCache: 0,
  totalCostUsd: 0, totalEnergyWh: 0, byModel: [], hasData: false,
};

const noHealth: FleetHealthData = {
  items: [], total: 0, hasIssues: false,
  counts: { deadlock: 0, stalled: 0, quarantine: 0, blocked: 0, attention: 0, denied: 0 },
};

describe("FleetLessonsView (#3481)", () => {
  it("distinguishes STILL LOADING from genuinely empty", () => {
    // The distinction the card exists to make: an empty list before the first poll answers is not
    // "no lessons", and claiming so would be a lie the user cannot see through.
    const { unmount } = render(<FleetLessonsView lessons={[]} loaded={false} />);
    expect(screen.queryByText(/No lessons yet/i)).toBeNull();
    unmount();

    render(<FleetLessonsView lessons={[]} loaded />);
    expect(screen.getByText(/No lessons yet/i)).toBeTruthy();
  });

  it("renders lessons and truncates past six, saying how many were withheld", () => {
    const many = Array.from({ length: 8 }, (_, i) => lesson(`l${i}`));
    render(<FleetLessonsView lessons={many} loaded />);
    // The title is the RULE; the mistake renders as its own sub-line.
    expect(screen.getByText("rule l0")).toBeTruthy();
    expect(screen.getByText("mistake l0")).toBeTruthy();
    // 7th and 8th are withheld — and the count is stated rather than silently dropped.
    expect(screen.queryByText("rule l7")).toBeNull();
    expect(screen.getByText(/\+2 more/)).toBeTruthy();
  });

  it("shows a recurrence chip only when a lesson actually recurred", () => {
    const { unmount } = render(<FleetLessonsView lessons={[lesson("a", { seen: 3 })]} loaded />);
    expect(screen.getByText("×3")).toBeTruthy();
    unmount();
    render(<FleetLessonsView lessons={[lesson("a", { seen: 1 })]} loaded />);
    expect(screen.queryByText("×1")).toBeNull();
  });
});

describe("CostEnergyView (#3481)", () => {
  it("renders the no-usage empty state rather than a row of zeroes", () => {
    render(<CostEnergyView cost={emptyCost} co2={0} />);
    expect(screen.getByText(/No token usage yet/i)).toBeTruthy();
  });

  it("renders totals and the per-model split when there is data", () => {
    const cost: FleetCost = {
      ...emptyCost,
      totalTokens: 1500, totalInput: 1000, totalOutput: 500,
      totalCostUsd: 1.25, totalEnergyWh: 240, hasData: true,
      byModel: [{ model: "claude-opus-4", tokens: 1500, costUsd: 1.25, energyWh: 240 }],
    };
    render(<CostEnergyView cost={cost} co2={0.096} />);
    expect(screen.getAllByText("$1.25").length).toBeGreaterThan(0);
    expect(screen.getByText("claude-opus-4")).toBeTruthy();
    // Energy is labelled as an ESTIMATE everywhere it appears — it is not metered, and the card
    // must never let it read as a measurement.
    expect(screen.getByText(/energy · est\./i)).toBeTruthy();
  });
});

describe("FleetHealthView (#3481)", () => {
  it("distinguishes STILL LOADING from all-clear", () => {
    const { unmount } = render(<FleetHealthView health={noHealth} permLoaded={false} />);
    expect(screen.queryByText(/All clear/i)).toBeNull();
    unmount();

    render(<FleetHealthView health={noHealth} permLoaded />);
    expect(screen.getByText(/All clear/i)).toBeTruthy();
  });

  it("renders each issue with its kind label and detail", () => {
    const health: FleetHealthData = {
      items: [
        { kind: "deadlock", label: "api-stream", detail: "waiting on ui-stream", sortKey: Infinity, danger: true },
        { kind: "denied", label: "ui-stream", detail: "git push refused", sortKey: 2, danger: false },
      ],
      counts: { deadlock: 1, stalled: 0, quarantine: 0, blocked: 0, attention: 0, denied: 1 },
      total: 2, hasIssues: true,
    };
    render(<FleetHealthView health={health} permLoaded />);
    expect(screen.getByText("deadlock")).toBeTruthy();
    expect(screen.getByText("waiting on ui-stream")).toBeTruthy();
    expect(screen.getByText("git push refused")).toBeTruthy();
  });

  it("truncates past twelve and states the remainder", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      kind: "denied" as const, label: `w${i}`, detail: `detail ${i}`, sortKey: i, danger: false,
    }));
    const health: FleetHealthData = {
      items, total: 15, hasIssues: true,
      counts: { deadlock: 0, stalled: 0, quarantine: 0, blocked: 0, attention: 0, denied: 15 },
    };
    render(<FleetHealthView health={health} permLoaded />);
    expect(screen.queryByText("detail 14")).toBeNull();
    expect(screen.getByText(/\+3 more/)).toBeTruthy();
  });
});
