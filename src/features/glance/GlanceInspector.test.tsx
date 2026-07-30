// GlanceInspector node Resume action (#glance-resume) — the "Resume" button in a drilled agent's
// right details pane: labelled to jump into a live pane, or relaunch a dormant one.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlanceInspector } from "./GlanceInspector";
import { buildGraph, type GRawNode } from "./lib/glanceGraph";

const NODES: GRawNode[] = [
  { id: "director", slug: "director", role: "infra", roleLabel: "director", health: "healthy", activity: "building" },
  { id: "api", slug: "api", role: "service", roleLabel: "worker", health: "off", activity: "idle" },
];
const model = buildGraph(NODES, []);

describe("GlanceInspector node Resume (#glance-resume)", () => {
  it("renders a Resume action for an agent node and calls onResumeNode with the node id", () => {
    const onResumeNode = vi.fn();
    render(<GlanceInspector model={model} selType="node" selId="api" onSelectNode={() => {}} onClose={() => {}} onResumeNode={onResumeNode} nodeLive={false} />);
    const btn = screen.getByRole("button", { name: /Resume session/i });
    fireEvent.click(btn);
    expect(onResumeNode).toHaveBeenCalledWith("api");
  });

  it("labels the action 'Open session' when the agent is live (jump vs relaunch)", () => {
    render(<GlanceInspector model={model} selType="node" selId="api" onSelectNode={() => {}} onClose={() => {}} onResumeNode={() => {}} nodeLive={true} />);
    expect(screen.getByRole("button", { name: /Open session/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Resume session/i })).toBeNull();
  });

  it("does not render a Resume action when onResumeNode is absent (e.g. the L0 project view)", () => {
    render(<GlanceInspector model={model} selType="node" selId="api" onSelectNode={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /Resume session/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open session/i })).toBeNull();
  });
});
