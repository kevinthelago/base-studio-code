import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { GlanceNode } from "./GlanceNode";
import { GLANCE_NODE_ANIM_CLASSES } from "./glanceNodeMotion";
import type { GNode } from "./lib/glanceGraph";

const node = (over: Partial<GNode> = {}): GNode => ({
  id: "auth", slug: "auth", role: "service", health: "healthy", activity: "building",
  rollupHealth: "healthy", x: 0, y: 0, ...over,
} as GNode);

const props = (n: GNode, state: "building" | null) => ({
  n, border: "var(--border)", boxShadow: "none", healthColor: "green", healthPulse: false,
  inherited: false, roleColor: "blue", roleLabel: "build", bottomText: "building",
  bottomColor: "var(--fg-muted)", bottomPulse: false, isOff: false, degraded: false,
  ownDegraded: false, state,
});

describe("GlanceNode binds its states to authored motion (#4032)", () => {
  afterEach(() => cleanup());

  it("stamps the state so the compiled kit CSS can bind to it", () => {
    // The selector in the motion data IS `[data-node-state="building"]`, so this attribute is the
    // entire binding — no class bookkeeping in the component, and a designer reading the record can
    // see which state each animation belongs to.
    const { container } = render(<GlanceNode {...props(node(), "building")} />);
    expect(container.querySelector('[data-node-state="building"]')).not.toBeNull();
  });

  it("carries the applying classes", () => {
    const { container } = render(<GlanceNode {...props(node(), "building")} />);
    const el = container.querySelector("[data-node-state]")!;
    for (const cls of GLANCE_NODE_ANIM_CLASSES.split(" ")) expect(el.className).toContain(cls);
  });

  it("stamps NO state when the node is still", () => {
    // A complete/idle node must not match either animation's selector — its stillness is the point.
    const { container } = render(<GlanceNode {...props(node({ activity: "complete" }), null)} />);
    expect(container.querySelector("[data-node-state]")).toBeNull();
  });

  it("shows the completion marker only for a complete node", () => {
    const done = render(<GlanceNode {...props(node({ activity: "complete" }), null)} />);
    expect(done.container.textContent).toContain("✓");
    cleanup();
    const busy = render(<GlanceNode {...props(node(), "building")} />);
    expect(busy.container.textContent).not.toContain("✓");
  });

  it("hides the completion marker on a deactivated or degraded node", () => {
    // `off` reads calm and a degraded node shows its fault word — neither should claim success.
    const off = render(<GlanceNode {...{ ...props(node({ activity: "complete" }), null), isOff: true }} />);
    expect(off.container.textContent).not.toContain("✓");
    cleanup();
    const bad = render(<GlanceNode {...{ ...props(node({ activity: "complete" }), null), degraded: true }} />);
    expect(bad.container.textContent).not.toContain("✓");
  });

  it("renders the node's identity and its two label rows", () => {
    const { container } = render(<GlanceNode {...props(node(), "building")} />);
    expect(container.textContent).toContain("auth");     // slug
    expect(container.textContent).toContain("build");    // role label
    expect(container.textContent).toContain("building"); // activity word
  });
});

describe("the health dot (#4040 — restored with the glow removed)", () => {
  afterEach(() => cleanup());

  it("paints the node's health colour", () => {
    // Health is a COLOUR. #4037 removed this dot because the glow carried it; #4040 removed the glow
    // because an always-on wash spent the node's strongest signal on the one thing carrying no
    // information. Without the dot, health would have had no colour surface at all.
    const { container } = render(<GlanceNode {...{ ...props(node(), "building"), healthColor: "rgb(1, 2, 3)" }} />);
    const dot = container.querySelector('[title^="healthy"]') as HTMLElement;
    expect(dot).not.toBeNull();
    expect(dot.style.background).toBe("rgb(1, 2, 3)");
  });

  it("dims an INHERITED dot and does not pulse it", () => {
    // #2541 — the eye should land on the ORIGIN of a fault, not on everything downstream of it.
    const { container } = render(<GlanceNode {...{ ...props(node(), null), inherited: true, healthPulse: true }} />);
    const dot = container.querySelector("[title]") as HTMLElement;
    expect(dot.style.opacity).toBe("0.5");
    expect(dot.style.animation).toBe("none");
  });

  it("pulses at the ORIGIN of a fault", () => {
    const { container } = render(<GlanceNode {...{ ...props(node(), null), healthPulse: true }} />);
    const dot = container.querySelector("[title]") as HTMLElement;
    expect(dot.style.animation).toContain("glance-softpulse");
  });
});
