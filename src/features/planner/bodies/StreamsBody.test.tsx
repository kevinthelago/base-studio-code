// The unified Streams pane (#…): the graph overview always shows; when the `fleet` substep is on,
// the fleet config renders as collapsible cards — Coordination (collapsed by default), the Fleet
// roster (open), and Shared dependencies (collapsed).
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { StreamsBody } from "./StreamsBody";
import type { Agent } from "../pane/projectPane.types";
import type { ProjectPaneData } from "../pane/projectPaneData";

const flow = { autonomy: "continuous", push: "auto-PR", gate: "soft" };
const agent = (id: string, repo = "acme/web"): Agent =>
  ({
    id, name: id, role: "worker", status: "idle", repo, color: "#7c93ff", initial: id[0]!.toUpperCase(),
    owns: [`${id}/**`], issues: [], preset: "Autonomous", perm: {}, flow, ctx: 0,
  } as unknown as Agent);

const data = {
  agents: [agent("api"), agent("ui")], topology: "hybrid",
  relationships: [], relationshipArtifacts: [], dependencies: [], registries: {},
} as unknown as ProjectPaneData;

describe("StreamsBody — unified fleet cards (#…)", () => {
  it("renders the three fleet cards; Coordination is collapsed and the Fleet roster is open by default", () => {
    render(<StreamsBody data={data} fleet />);
    // All three card headers are present…
    expect(screen.getByText("Coordination")).toBeInTheDocument();
    expect(screen.getByText("Fleet")).toBeInTheDocument();
    expect(screen.getByText("Shared dependencies")).toBeInTheDocument();
    // …Coordination starts collapsed (its topology control is hidden until opened)…
    expect(screen.queryByTestId("topology-control")).toBeNull();
    // …but the Fleet roster is open, so its stream count shows.
    expect(screen.getByText(/2 agents/)).toBeInTheDocument();
  });

  it("expands the Coordination card on header click", () => {
    render(<StreamsBody data={data} fleet />);
    fireEvent.click(screen.getByText("Coordination"));
    expect(screen.getByTestId("topology-control")).toBeInTheDocument();
  });

  it("shows only the graph (no fleet cards) when the fleet substep is off", () => {
    render(<StreamsBody data={data} />);
    expect(screen.queryByText("Coordination")).toBeNull();
    expect(screen.queryByText("Fleet")).toBeNull();
    expect(screen.queryByText("Shared dependencies")).toBeNull();
  });

  it("shows the empty fleet state when the substep is on but no streams are planned", () => {
    render(<StreamsBody data={{ ...data, agents: [] } as unknown as ProjectPaneData} fleet />);
    expect(screen.getByText(/No fleet yet/)).toBeInTheDocument();
    expect(screen.queryByText("Coordination")).toBeNull();
  });
});
