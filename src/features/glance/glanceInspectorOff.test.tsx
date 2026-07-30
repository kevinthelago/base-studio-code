// The per-node activate/deactivate control in the node details pane (#3239). The inspector exposes a
// Turn off / Turn on button (only when `onToggleOff` is supplied — the L0 project network), flips the
// node's OFF state, and reflects the current state in its copy.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GlanceInspector } from "./GlanceInspector";
import { buildGraph, type GRawNode } from "./lib/glanceGraph";

const node = (health: GRawNode["health"]): GRawNode => ({
  id: "a", slug: "alpha", role: "service", category: "greenfield", health, activity: "building",
});
const modelWith = (health: GRawNode["health"]) => buildGraph([node(health)], []);

describe("GlanceInspector — activate / deactivate control (#3239)", () => {
  it("an ACTIVE node shows 'Turn off'; clicking it deactivates (onToggleOff(true))", () => {
    const onToggleOff = vi.fn();
    render(
      <GlanceInspector model={modelWith("healthy")} selType="node" selId="a"
        onSelectNode={() => {}} onClose={() => {}} offOn={false} onToggleOff={onToggleOff} />,
    );
    expect(screen.getByText("Node is active")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "turn node off" }));
    expect(onToggleOff).toHaveBeenCalledWith(true);
  });

  it("an OFF node shows 'Turn on' + 'Node is off'; clicking it reactivates (onToggleOff(false))", () => {
    const onToggleOff = vi.fn();
    render(
      <GlanceInspector model={modelWith("off")} selType="node" selId="a"
        onSelectNode={() => {}} onClose={() => {}} offOn={true} onToggleOff={onToggleOff} />,
    );
    expect(screen.getByText("Node is off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "turn node on" }));
    expect(onToggleOff).toHaveBeenCalledWith(false);
  });

  it("omits the control when onToggleOff is absent (a drilled fleet node)", () => {
    render(
      <GlanceInspector model={modelWith("healthy")} selType="node" selId="a"
        onSelectNode={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByText("Node is active")).toBeNull();
    expect(screen.queryByRole("button", { name: /turn node/i })).toBeNull();
  });
});
