// The individual-node ▶ START action in the node details pane (#3341/#3348). The inspector renders a
// "▶ Start node" button only when `onStart` is supplied (a drilled fleet node whose cell is stopped);
// clicking it (re)launches just that node. Whole-fleet start lives in the graph toolbar, not here.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlanceInspector } from "./GlanceInspector";
import { buildGraph, type GRawNode } from "./lib/glanceGraph";

const node: GRawNode = { id: "api-client", slug: "api client", role: "service", roleLabel: "worker", health: "idle", activity: "idle" };
const model = buildGraph([node], []);

describe("GlanceInspector — node ▶ Start action (#3341/#3348)", () => {
  it("renders '▶ Start node' and fires onStart(selId) on click when onStart is supplied", () => {
    const onStart = vi.fn();
    render(
      <GlanceInspector model={model} selType="node" selId="api-client"
        onSelectNode={() => {}} onClose={() => {}} onStart={onStart} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "▶ Start node" }));
    expect(onStart).toHaveBeenCalledWith("api-client");
  });

  it("omits the Start action when onStart is absent (a live node opens its stream instead)", () => {
    render(
      <GlanceInspector model={model} selType="node" selId="api-client"
        onSelectNode={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "▶ Start node" })).toBeNull();
  });
});
