// #4052 — what the `modifying` health state actually RENDERS, and what the removed lifecycle axis no
// longer does. These assert the DOM rather than the model, because both facts are presentational and a
// type-level change would not have caught either: the pulse character is an inline style string, and
// the missing chip is an absence.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GlanceNode } from "./GlanceNode";
import { HEALTH_META, buildGraph, type GHealth } from "./lib/glanceGraph";

/** Render one node card at `health`, with the canvas's own HEALTH_META-derived pulse props. */
function renderNode(health: GHealth, opts: { roleLabel?: string } = {}) {
  const model = buildGraph([{ id: "a", slug: "alpha", role: "service", health, activity: "building" }], []);
  const n = model.nodes[0];
  const meta = HEALTH_META[health];
  return render(
    <GlanceNode
      n={n}
      border="var(--border)"
      boxShadow="none"
      healthColor={meta.color}
      healthPulse={meta.pulse}
      healthPulseMs={meta.pulseMs}
      healthGlow={meta.glow}
      inherited={false}
      roleColor={opts.roleLabel ? "var(--graph-kind-service)" : undefined}
      roleLabel={opts.roleLabel}
      bottomText="building"
      bottomColor="var(--fg-muted)"
      bottomPulse={false}
      isOff={false}
      degraded={false}
      ownDegraded={false}
      state={null}
    />,
  );
}

/** The health DOT is the 8px round element carrying the state's `title`. */
function healthDot(container: HTMLElement, health: GHealth): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[title="${health}"]`);
  expect(el, `no health dot for ${health}`).toBeTruthy();
  return el!;
}

describe("GlanceNode — the `modifying` health state (#4052)", () => {
  it("breathes SLOWLY and without a halo — a busy node must not compete with a broken one", () => {
    const { container } = renderNode("modifying");
    const dot = healthDot(container, "modifying");
    expect(dot.style.animation).toContain("2600ms");
    // No glow. The halo is the alarm's carrying-power; spending it here would make every working
    // project shout as loudly as a failing one.
    expect(dot.style.boxShadow).toBe("none");
  });

  it("leaves the ERROR alarm exactly as it was — fast and haloed", () => {
    const { container } = renderNode("error");
    const dot = healthDot(container, "error");
    expect(dot.style.animation).toContain("1400ms");
    expect(dot.style.boxShadow).not.toBe("none");
  });

  it("shares `complete`'s blue on purpose — motion is the only difference", () => {
    // Separate token NAMES (so a theme can diverge them later) resolving to the SAME value today.
    // Asserted against tokens.css, since comparing the `var(--…)` strings would only prove they differ.
    const css = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
    const value = (name: string) => css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
    expect(HEALTH_META.modifying.color).not.toBe(HEALTH_META.complete.color);
    expect(value("--graph-health-modifying")).toBe(value("--graph-health-complete"));
    // …and `complete` is the STILL one, which is what makes the pair legible.
    expect(HEALTH_META.complete.pulse).toBe(false);
    expect(HEALTH_META.modifying.pulse).toBe(true);
  });

  it("renders NO lower-left chip for an L0 project — the lifecycle axis is gone", () => {
    // Falling back to `role` here would have resurrected the hash-per-id microservices tier that the
    // category axis replaced, so the slot has to be genuinely empty, not defaulted.
    const { container } = renderNode("modifying");
    expect(container.textContent).not.toContain("SERVICE");
    expect(container.textContent).not.toContain("service");
    expect(container.textContent).not.toContain("greenfield");
    expect(container.textContent).not.toContain("maintain");
  });

  it("still renders the chip for a FLEET node, which does have a function to name", () => {
    const { container } = renderNode("healthy", { roleLabel: "director" });
    expect(container.textContent).toContain("director");
  });
});
