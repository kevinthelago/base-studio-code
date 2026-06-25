import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TelemetryView } from "./TelemetryView";
import type { PaneTokenUsage } from "@/app/console/lib/usePaneTokenUsage";

const usage: PaneTokenUsage = {
  pane: "proj:worker-A",
  session_id: "s1",
  model: "claude-sonnet-4-6",
  input_tokens: 1_200_000,
  output_tokens: 48_000,
  cache_creation_tokens: 9_000,
  cache_read_tokens: 220_000,
  cost_usd: 1.06,
};

describe("TelemetryView", () => {
  it("shows an empty state when the pane has no usage yet", () => {
    render(<TelemetryView />);
    expect(screen.getByText(/No session telemetry yet/i)).toBeInTheDocument();
  });

  it("renders the real model, token rollup, and cost", () => {
    render(<TelemetryView usage={usage} />);
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument(); // actual model
    expect(screen.getAllByText("1.2M").length).toBeGreaterThan(0);     // tokens in / session, formatted
    expect(screen.getByText("48K")).toBeInTheDocument();               // tokens out
    expect(screen.getAllByText("$1.06").length).toBeGreaterThan(0);    // cost (card + row)
    expect(screen.getByText("Session tokens")).toBeInTheDocument();
  });
});
