// The unified Streams pane (#2053): the dependency graph is the centerpiece; when the `fleet` substep
// is on, selecting a node opens ONE stream inspector card (no roster duplicating the graph), and the
// fleet-wide Coordination + Shared-dependencies controls render below as secondary collapsible cards.
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
    kickoff: `You are the ${id} work stream…`, scope: `owns ${id}/**`,
  } as unknown as Agent);

const data = {
  agents: [agent("api"), agent("ui")], topology: "hybrid",
  relationships: [], relationshipArtifacts: [], dependencies: [], registries: {},
} as unknown as ProjectPaneData;

describe("StreamsBody — graph-first unified pane (#2053)", () => {
  it("shows the fleet-wide cards but NOT a separate Fleet roster (the graph is the roster)", () => {
    render(<StreamsBody data={data} fleet />);
    expect(screen.getByText("Coordination")).toBeInTheDocument();
    expect(screen.getByText("Shared dependencies")).toBeInTheDocument();
    // The old always-open "Fleet" roster card is gone — the graph is the single stream list.
    expect(screen.queryByText("Fleet")).toBeNull();
    // With no node focused, a hint invites selecting one in the graph.
    expect(screen.getByText(/Select a stream in the graph/)).toBeInTheDocument();
  });

  it("expands the Coordination card on header click", () => {
    render(<StreamsBody data={data} fleet />);
    expect(screen.queryByTestId("topology-control")).toBeNull();
    fireEvent.click(screen.getByText("Coordination"));
    expect(screen.getByTestId("topology-control")).toBeInTheDocument();
  });

  it("shows only the graph (no fleet cards) when the fleet substep is off", () => {
    render(<StreamsBody data={data} />);
    expect(screen.queryByText("Coordination")).toBeNull();
    expect(screen.queryByText("Shared dependencies")).toBeNull();
    expect(screen.queryByText(/Select a stream in the graph/)).toBeNull();
  });

  it("shows the empty fleet state when the substep is on but no streams are planned", () => {
    render(<StreamsBody data={{ ...data, agents: [] } as unknown as ProjectPaneData} fleet />);
    expect(screen.getByText(/No fleet yet/)).toBeInTheDocument();
    expect(screen.queryByText("Coordination")).toBeNull();
  });
});
