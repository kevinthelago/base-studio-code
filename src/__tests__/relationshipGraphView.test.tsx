import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { RelationshipGraphView } from "../screens/projects/RelationshipGraphView";
import { RelationshipInspector } from "../screens/projects/RelationshipInspector";
import {
  buildRelationshipGraph, computeSpotlight, hardLabel, restOpacity, runtimeNote,
  type RelStream, type RelationshipArtifact, type AgentRelationship,
} from "../screens/projects/relationshipGraph";

const STREAMS: RelStream[] = [
  { id: "schema", role: "worker", repo: "core", owns: ["packages/schema/**"] },
  { id: "auth", role: "worker", repo: "api", owns: ["src/auth/**"] },
  { id: "web", role: "worker", repo: "web", owns: ["apps/web/**"] },
];
const ARTIFACTS: RelationshipArtifact[] = [
  { id: "user-schema", name: "user-schema", kind: "schema", producer: "schema", consumers: ["auth"], status: "ready" },
];
const EDGES: AgentRelationship[] = [
  { id: "h1", from: "schema", to: "auth", kind: "handoff", artifact: "user-schema", hardness: "blocking", via: "direct" },
  { id: "n1", from: "auth", to: "web", kind: "notify", hardness: "notify", via: "direct" },
];
const graph = () => buildRelationshipGraph(STREAMS, ARTIFACTS, EDGES, "hybrid");

const noop = () => {};

describe("relationshipGraph display helpers", () => {
  it("restOpacity foregrounds handoff/blocking, recedes the rest", () => {
    expect(restOpacity("handoff")).toBeGreaterThan(restOpacity("notify"));
    expect(restOpacity("blocking")).toBeGreaterThan(restOpacity("sequence"));
  });
  it("hardLabel + runtimeNote read naturally", () => {
    expect(hardLabel("blocking")).toBe("hard wait");
    expect(hardLabel("soft")).toBe("stub & reconcile");
    const e = graph().edges.find((x) => x.id === "h1")!;
    expect(runtimeNote(e)).toContain("contract:user-schema");
    expect(runtimeNote(e)).toContain("[peer latch]");
  });
});

describe("computeSpotlight", () => {
  it("an agent focus brightens it + its neighbors and lights its edges/artifacts", () => {
    const sp = computeSpotlight(graph(), { type: "agent", id: "schema" });
    expect(sp.active).toBe(true);
    expect(sp.brightStreams.has("schema")).toBe(true);
    expect(sp.brightStreams.has("auth")).toBe(true);   // neighbor via h1
    expect(sp.brightStreams.has("web")).toBe(false);   // not a neighbor of schema
    expect(sp.litEdges.has("h1")).toBe(true);
    expect(sp.litArtifacts.has("user-schema")).toBe(true);
  });
  it("an artifact focus lights its producer + consumers", () => {
    const sp = computeSpotlight(graph(), { type: "art", id: "user-schema" });
    expect(sp.brightStreams.has("schema")).toBe(true);
    expect(sp.brightStreams.has("auth")).toBe(true);
    expect(sp.litEdges.has("h1")).toBe(true);
  });
  it("no focus is inactive", () => {
    expect(computeSpotlight(graph(), null).active).toBe(false);
  });
});

describe("RelationshipGraphView (swimlanes)", () => {
  it("renders one lane per stream, phase guides, and the artifact token", () => {
    const { getByTestId, getAllByText, getByText } = render(
      <RelationshipGraphView graph={graph()} focus={null} hover={null} onHover={noop} onFocusAgent={noop} onInspectEdge={noop} onInspectArtifact={noop} />,
    );
    expect(getByTestId("relationship-graph-svg")).toBeTruthy();
    expect(getAllByText("schema").length).toBeGreaterThan(0);  // lane label + station node
    expect(getByText("user-schema")).toBeTruthy();             // artifact token
    expect(getByText("phase 0")).toBeTruthy();                 // phase column guide
  });

  it("fires onFocusAgent when a lane is clicked", () => {
    const onFocusAgent = vi.fn();
    const { getAllByText } = render(
      <RelationshipGraphView graph={graph()} focus={null} hover={null} onHover={noop} onFocusAgent={onFocusAgent} onInspectEdge={noop} onInspectArtifact={noop} />,
    );
    fireEvent.click(getAllByText("auth")[0]);
    expect(onFocusAgent).toHaveBeenCalledWith("auth");
  });
});

describe("RelationshipInspector", () => {
  it("shows the hint + counts when nothing is focused", () => {
    const { getByText } = render(
      <RelationshipInspector graph={graph()} focus={null} onFocusAgent={noop} onInspectArtifact={noop} onInspectEdge={noop} />,
    );
    expect(getByText(/Hover a stream to spotlight/)).toBeTruthy();
    expect(getByText(/1 contracts · 1 handoffs/)).toBeTruthy();
  });

  it("spells out a focused stream's relationships with runtime detail", () => {
    // schema produces the contract; auth consumes it and notifies web.
    const producer = render(
      <RelationshipInspector graph={graph()} focus={{ type: "agent", id: "schema" }} onFocusAgent={noop} onInspectArtifact={noop} onInspectEdge={noop} />,
    );
    expect(producer.getByText("produces contract:user-schema")).toBeTruthy();
    producer.unmount();

    const consumer = render(
      <RelationshipInspector graph={graph()} focus={{ type: "agent", id: "auth" }} onFocusAgent={noop} onInspectArtifact={noop} onInspectEdge={noop} />,
    );
    expect(consumer.getByText("waits on contract:user-schema")).toBeTruthy();
    expect(consumer.getByText("notifies web")).toBeTruthy();
  });

  it("shows an artifact's consumers + coord ref", () => {
    const { getByText } = render(
      <RelationshipInspector graph={graph()} focus={{ type: "art", id: "user-schema" }} onFocusAgent={noop} onInspectArtifact={noop} onInspectEdge={noop} />,
    );
    expect(getByText("contract:user-schema")).toBeTruthy();
    expect(getByText("auth consumes it")).toBeTruthy();
  });
});
