// Drill-aware legend (#2561): the LIFECYCLE/EDGE columns speak the project-network vocabulary at the
// root (the category header was renamed ROLE → LIFECYCLE by #2583) and the fleet's Org grammar (agent
// FUNCTION groups + relationship archetypes) when drilled.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlanceOverlays } from "./GlanceCanvas";

describe("GlanceOverlays legend (#2561)", () => {
  it("L0 (no drill): project-network vocabulary — LIFECYCLE + the relabelled 'depends on' edge (never 'API contract')", () => {
    render(<GlanceOverlays />);
    expect(screen.getByText("LIFECYCLE")).toBeTruthy();
    expect(screen.getByText("EDGE")).toBeTruthy();
    expect(screen.getByText("depends on")).toBeTruthy();
    expect(screen.getByText("data flow")).toBeTruthy();
    expect(screen.queryByText("API contract")).toBeNull();
    // #4037 — `off` no longer has a colour SWATCH, because nothing paints it: a deactivated node is
    // conveyed by dimming (#4034). The legend must still TEACH that, or the one state without a colour
    // would also be the one state without an explanation — which is what #3239 added this row for.
    expect(screen.queryByText("off")).toBeNull();
    // #4042 — the `dimmed = off` row is gone with the `idle` state: `off` is now the ONE neutral
    // (deactivated, never launched, or structural), and it has no swatch because nothing paints it.
    expect(screen.queryByText("dimmed = off")).toBeNull();
    // …and the two states that had no row at all until now.
    expect(screen.getByText("complete")).toBeTruthy();
    expect(screen.getByText("needs you")).toBeTruthy();
  });

  it("L1 (drill): FUNCTION groups + the Org archetypes present in the drilled fleet", () => {
    render(<GlanceOverlays drill archetypes={["manages", "oversees"]} />);
    expect(screen.getByText("FUNCTION")).toBeTruthy();
    expect(screen.getByText("orchestrate")).toBeTruthy();
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("RELATIONSHIP")).toBeTruthy();
    expect(screen.getByText("Manages")).toBeTruthy();   // archetype label from the Org vocabulary
    expect(screen.getByText("Oversees")).toBeTruthy();
    // the L0 LIFECYCLE label is not shown while drilled (the header reads FUNCTION there)
    expect(screen.queryByText("LIFECYCLE")).toBeNull();
  });
});
