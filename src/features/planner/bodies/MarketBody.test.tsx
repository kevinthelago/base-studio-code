import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import { MARKET_DIMENSIONS, marketWeights, weightedMarketScore, type MarketConfig } from "../lib/marketConfig";
import { MarketBody } from "./MarketBody";

const PID = "p-market";

/** A fully-scored assessment (all 4s) with competitors + sizing + verdict. */
const fullConfig = (): MarketConfig => ({
  summary: "Incumbents underserve small teams; the gap is structural.",
  scores: Object.fromEntries(MARKET_DIMENSIONS.map((id) => [
    id, { score: 4, rationale: "cited desk research", sources: ["https://example.com/a", "https://example.com/b"] },
  ])),
  sizing: { tam: "$4.2B", som: "$18M" },
  competitors: [
    { name: "IncumbentCo", pricing: "$49/mo", segment: "SMB", source: "https://example.com/pricing" },
    { name: "LegacySuite", segment: "Enterprise" },
  ],
  verdict: { recommendation: "go", rationale: "Severe, frequent problem with a reachable wedge." },
});

beforeEach(() => {
  useAppStore.setState({ planMarketConfig: {}, projectBlueprintId: {} });
});

describe("MarketBody — empty state", () => {
  it("shows the planner-records-this hint when no assessment is set", () => {
    render(<MarketBody projectId={PID} />);
    expect(screen.getByText("No market assessment yet")).toBeTruthy();
    expect(screen.getByText(/bsc plan market set/)).toBeTruthy();
  });
});

describe("MarketBody — full payload", () => {
  it("renders the summary, all six rubric rows, competitors, and the verdict chip", () => {
    useAppStore.getState().setPlanMarketConfig(PID, fullConfig());
    render(<MarketBody projectId={PID} />);

    // Gap statement.
    expect(screen.getByText(/gap is structural/)).toBeTruthy();
    // Six scored rows, one per canonical dimension, each showing its score + sources count.
    for (const id of MARKET_DIMENSIONS) {
      expect(screen.getByTestId(`market-dim-${id}`)).toBeTruthy();
    }
    expect(screen.getAllByText("4/5")).toHaveLength(6);
    expect(screen.getAllByText("2 src")).toHaveLength(6);
    // The weighted total (greenfield weights by default — no blueprint bound): all 4s → 80/100.
    expect(screen.getByText("80/100")).toBeTruthy();
    // Competitors matrix.
    expect(screen.getByTestId("market-competitor-IncumbentCo")).toBeTruthy();
    expect(screen.getByText("$49/mo")).toBeTruthy();
    expect(screen.getByText("Enterprise")).toBeTruthy();
    // Sizing block.
    expect(screen.getByText("$4.2B")).toBeTruthy();
    // Verdict chip + rationale.
    expect(screen.getByTestId("market-verdict").textContent).toContain("go");
    expect(screen.getByText(/reachable wedge/)).toBeTruthy();
  });

  it("weights the total by the project's DISCOVERED lifecycle (#3785)", () => {
    // Score a skewed profile so lifecycle weighting changes the total.
    const cfg = fullConfig();
    cfg.scores.problemSeverity = { score: 5, rationale: "r", sources: ["s"] };
    cfg.scores.reachableMarket = { score: 1, rationale: "r", sources: ["s"] };
    useAppStore.getState().setPlanMarketConfig(PID, cfg);
    // Classify the project as a TRANSFORM — severity-weighted. Lifecycle left the blueprint model
    // in #3785; the planner discovers it (#3784), so the weighting reads the classification.
    useAppStore.setState({ planClassification: { [PID]: { lifecycle: "transform" } } });
    render(<MarketBody projectId={PID} />);
    const expected = weightedMarketScore(cfg, marketWeights("transform"));
    expect(screen.getByText(`${expected}/100`)).toBeTruthy();
    expect(screen.getByText("transform weights")).toBeTruthy();
  });
});
