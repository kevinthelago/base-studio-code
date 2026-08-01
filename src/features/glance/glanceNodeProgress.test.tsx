// The node's owned-issue progress bar (#4050, made legible in #4118).
//
// It shipped as a 2px hairline on the bottom edge — the width of a border, rounding toward nothing at
// any graph zoom below 1 — so the feature read as MISSING rather than empty, twice. These pin that the
// bar is in the DOM at all (the check never run when #4102 fed it data) and that its counts are shown
// as TEXT, which is what a fill alone cannot say.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { GlanceNode } from "./GlanceNode";
import type { GNode } from "./lib/glanceGraph";

const node = (over: Partial<GNode> = {}): GNode => ({
  id: "auth", slug: "auth", role: "service", health: "healthy", activity: "building",
  rollupHealth: "healthy", x: 0, y: 0, ...over,
} as GNode);

const props = (n: GNode) => ({
  n, border: "var(--border)", boxShadow: "none", healthColor: "green", healthPulse: false,
  inherited: false, roleColor: "blue", roleLabel: "build", bottomText: "building",
  bottomColor: "var(--fg-muted)", bottomPulse: false, isOff: false, degraded: false,
  ownDegraded: false, state: null as null,
});

afterEach(() => cleanup());

describe("GlanceNode progress (#4118)", () => {
  it("renders the bar AND its counts as readable text", () => {
    render(<GlanceNode {...props(node({ progress: { done: 3, total: 7 } }))} />);
    expect(screen.getByText("3/7")).toBeInTheDocument();
    expect(screen.getByTitle("3/7 issues complete")).toBeInTheDocument();
  });

  it("is tall enough to survive a zoomed-out graph", () => {
    // The regression that made this invisible: a 2px fill is a hairline. Anything under 4px rounds away
    // once the canvas scales below 1, which is the normal viewing zoom for a fleet of any size.
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 1, total: 4 } }))} />);
    const track = container.querySelector('[title="1/4 issues complete"] > div') as HTMLElement;
    expect(parseFloat(track.style.height)).toBeGreaterThanOrEqual(4);
  });

  it("fills proportionally, and fully at 100%", () => {
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 1, total: 4 } }))} />);
    const fill = container.querySelector('[title="1/4 issues complete"] > div > div') as HTMLElement;
    expect(fill.style.width).toBe("25%");
    cleanup();
    const done = render(<GlanceNode {...props(node({ progress: { done: 5, total: 5 } }))} />);
    expect((done.container.querySelector('[title="5/5 issues complete"] > div > div') as HTMLElement).style.width).toBe("100%");
  });

  it("draws NOTHING for a stream that owns no issues", () => {
    // An empty bar and a zero-progress bar say different things; only one of them is true here.
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 0, total: 0 } }))} />);
    expect(container.querySelector('[title$="issues complete"]')).toBeNull();
    cleanup();
    const none = render(<GlanceNode {...props(node())} />);
    expect(none.container.querySelector('[title$="issues complete"]')).toBeNull();
  });

  it("never eats a click meant for the node", () => {
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 2, total: 3 } }))} />);
    const bar = container.querySelector('[title="2/3 issues complete"]') as HTMLElement;
    expect(bar.style.pointerEvents).toBe("none");
  });
});
