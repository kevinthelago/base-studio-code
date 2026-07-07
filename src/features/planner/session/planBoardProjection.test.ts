// planBoardProjection (#2498) — the `plan` store_state domain payload from gate-hook fixtures.
import { describe, it, expect } from "vitest";
import type { Stage } from "../stages/focusedPlan";
import type { FleetPlan } from "../fleet/planFleet";
import { defaultService, type DeployConfig } from "../lib/deployConfig";
import { buildPlanBoardPayload } from "./planBoardProjection";

const stage = (key: string, status: Stage["status"], over: Partial<Stage> = {}): Stage => ({
  key, name: key, glyph: "◇", blurb: `${key} blurb`, gate: `${key} gate`,
  index: 0, total: 2, status, fraction: status === "complete" ? 1 : 0.5,
  unmet: [], ...over,
});

const fleet: FleetPlan = {
  recommended: 2,
  reasoning: "",
  streams: [
    { id: "auth", name: "Auth", repo: "acme/api", owns: ["src/auth/**"], issues: ["#1", "#2"], dependsOn: [], persona: "backend-dev" },
    { id: "ui", name: "UI", repo: "acme/web", owns: [], issues: ["#3"], dependsOn: ["auth"] },
  ],
  director: { enabled: true },
};

const base = {
  projectId: "demo",
  title: "Demo",
  currentStage: "features",
  statusLabel: "in_progress",
  gateReady: true,
  planComplete: false,
  stages: [
    stage("discovery", "complete"),
    stage("features", "active", { unmet: [{ label: "features defined", detail: "0 features" }], optional: false }),
  ],
  confirmed: new Set(["scope", "goal"]),
  skipped: ["market"],
};

describe("buildPlanBoardPayload", () => {
  it("carries the stage board with per-stage status + unmet gate reasons", () => {
    const out = buildPlanBoardPayload(base);
    expect(out).toMatchObject({
      projectId: "demo", title: "Demo", currentStage: "features",
      statusLabel: "in_progress", gateReady: true, planComplete: false,
    });
    expect(out.stages).toEqual([
      { key: "discovery", name: "discovery", glyph: "◇", status: "complete", fraction: 1, optional: undefined, unmet: [] },
      { key: "features", name: "features", glyph: "◇", status: "active", fraction: 0.5, optional: false, unmet: [{ label: "features defined", detail: "0 features" }] },
    ]);
    // Prompt/blurb prose stays desktop-side.
    expect(JSON.stringify(out.stages)).not.toContain("blurb");
  });

  it("sorts confirmed/skipped for a stable (dedup-friendly) serialization", () => {
    const out = buildPlanBoardPayload(base);
    expect(out.confirmed).toEqual(["goal", "scope"]);
    expect(out.skipped).toEqual(["market"]);
  });

  it("summarizes fleet streams (issue counts, deps, persona) + the director flag", () => {
    const out = buildPlanBoardPayload({ ...base, fleet });
    expect(out.streams).toEqual([
      { id: "auth", name: "Auth", repo: "acme/api", issues: 2, dependsOn: [], persona: "backend-dev" },
      { id: "ui", name: "UI", repo: "acme/web", issues: 1, dependsOn: ["auth"], persona: undefined },
    ]);
    expect(out.directorEnabled).toBe(true);
    // Owned globs / kickoff prompts are execution detail — not on the board.
    expect(JSON.stringify(out.streams)).not.toContain("src/auth");
  });

  it("defaults to an empty fleet + undefined configs without crashing", () => {
    const out = buildPlanBoardPayload(base);
    expect(out.streams).toEqual([]);
    expect(out.directorEnabled).toBe(false);
    expect(out.deploy).toEqual({ defined: false, services: [] });
    expect(out.market).toEqual({ defined: false, summary: "", recommendation: undefined });
  });

  it("summarizes deploy services and the market verdict", () => {
    // A REAL service (the same defaultService the planner seeds) so the `defined` gate helper
    // runs over a complete shape, with the summary fields overridden for the assertion.
    const deploy: DeployConfig = {
      services: [{ ...defaultService("acme/web"), id: "web", platform: "vercel", workload: "static" }],
    };
    const out = buildPlanBoardPayload({
      ...base,
      deploy,
      market: {
        summary: "Strong niche",
        scores: {},
        verdict: { recommendation: "go", rationale: "clear demand" },
      },
    });
    expect(out.deploy.services).toEqual([{ id: "web", repo: "acme/web", platform: "vercel", workload: "static" }]);
    expect(out.market).toMatchObject({ summary: "Strong niche", recommendation: "go" });
    // `defined` comes from the real gate helpers — a partial config stays false.
    expect(typeof out.deploy.defined).toBe("boolean");
    expect(out.market.defined).toBe(false); // no dimension scores → marketDefined is false
  });
});
