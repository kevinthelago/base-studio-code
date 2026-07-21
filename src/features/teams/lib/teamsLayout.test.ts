import { describe, it, expect } from "vitest";
import { teamsGrid, teamsBounds, teamStats, TEAM_CARD_W, TEAM_CARD_H } from "./teamsLayout";
import type { Team } from "./team";

const team = (over: Partial<Team>): Team => ({ id: "t", name: "T", positions: [], relationships: [], ...over });

describe("teamsGrid (#2742)", () => {
  it("returns one box per cell, row-major, capped at 3 columns", () => {
    const boxes = teamsGrid(7);
    expect(boxes).toHaveLength(7);
    // 7 cells over 3 cols → the 4th cell (index 3) starts a new row: same x as index 0, greater y.
    expect(boxes[3].x).toBe(boxes[0].x);
    expect(boxes[3].y).toBeGreaterThan(boxes[0].y);
    // cells in the same row share a y and step in x
    expect(boxes[1].y).toBe(boxes[0].y);
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
  });

  it("every box has the fixed card size", () => {
    for (const b of teamsGrid(4)) {
      expect(b.w).toBe(TEAM_CARD_W);
      expect(b.h).toBe(TEAM_CARD_H);
    }
  });

  // #2846 — the card must stay large enough to show a multi-line team description without
  // truncating it "way too soon". Guards against a future shrink that re-introduces the clipping.
  it("cards are sized to fit a multi-line description", () => {
    expect(TEAM_CARD_W).toBeGreaterThanOrEqual(280);
    expect(TEAM_CARD_H).toBeGreaterThanOrEqual(150);
  });
});

describe("teamsBounds (#2742)", () => {
  it("is null for zero cells and grows with the cell count", () => {
    expect(teamsBounds(0)).toBeNull();
    const one = teamsBounds(1)!;
    const many = teamsBounds(9)!;
    expect(one.w).toBeGreaterThan(0);
    expect(many.w).toBeGreaterThanOrEqual(one.w);
    expect(many.h).toBeGreaterThan(one.h);
  });
});

describe("teamStats (#2742)", () => {
  it("counts positions by kind", () => {
    const t = team({ positions: [
      { nodeId: "a", kind: "agent" },
      { nodeId: "b", kind: "agent" },
      { nodeId: "r", kind: "resource" },
      { nodeId: "e", kind: "external" },
    ] });
    const s = teamStats(t, []);
    expect(s.positions).toBe(4);
    expect(s.agents).toBe(2);
    expect(s.resources).toBe(1);
    expect(s.externals).toBe(1);
    expect(Array.isArray(s.depts)).toBe(true);
  });

  it("is empty for a team with no positions", () => {
    const s = teamStats(team({}), []);
    expect(s).toMatchObject({ positions: 0, agents: 0, resources: 0, externals: 0 });
  });
});
