// Drill-aware legend (#2561): at the root the project network keys HEALTH + LIFECYCLE + EDGE; drilled,
// it speaks the fleet's Org grammar (agent FUNCTION groups + relationship archetypes).
//
// The second column keys LIFECYCLE because the lifecycle CHIP is coloured (#4062/#4066) — five accents
// that mean nothing without a key. It briefly keyed ACTIVITY (#4064), a plain word with no colour
// mapping, which taught nothing a reader could not already read off the card.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlanceOverlays } from "./GlanceCanvas";

describe("GlanceOverlays legend (#2561)", () => {
  it("L0 (no drill): HEALTH + LIFECYCLE + EDGE — keys the node's two COLOURED channels", () => {
    render(<GlanceOverlays />);
    // #4066 — LIFECYCLE, because the chip is coloured and its five accents need a key. The column
    // that #4052 deleted keyed a DEAD axis (`resolveProjectCategory` always fell through to
    // `isDraft ? greenfield : maintain`); this one keys the planner's real classification (#4062).
    expect(screen.getByText("LIFECYCLE")).toBeTruthy();
    expect(screen.getByText("greenfield")).toBeTruthy();
    expect(screen.getByText("harvest")).toBeTruthy();
    // ACTIVITY has no colour mapping, so it gets no column — the word on the card IS the whole signal.
    expect(screen.queryByText("ACTIVITY")).toBeNull();
    expect(screen.queryByText("FUNCTION")).toBeNull();   // that is the L1 vocabulary
    expect(screen.getByText("HEALTH")).toBeTruthy();
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
    expect(screen.getAllByText("complete").length).toBeGreaterThan(0);
    // #4052 — `modifying`: work in flight, the rung between "nothing wrong" and "done".
    expect(screen.getByText("modifying")).toBeTruthy();
    // #4046 — `needs you` is gone from HEALTH: waiting on a person is an ACTIVITY, and the node says
    // so with its word. The legend keys health only.
    expect(screen.queryByText("needs you")).toBeNull();
  });

  it("L1 (drill): FUNCTION groups + the Org archetypes present in the drilled fleet", () => {
    render(<GlanceOverlays drill archetypes={["manages", "oversees"]} />);
    expect(screen.getByText("FUNCTION")).toBeTruthy();
    expect(screen.getByText("orchestrate")).toBeTruthy();
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("RELATIONSHIP")).toBeTruthy();
    expect(screen.getByText("Manages")).toBeTruthy();   // archetype label from the Org vocabulary
    expect(screen.getByText("Oversees")).toBeTruthy();
    // the L0 ACTIVITY label is not shown while drilled (the header reads FUNCTION there)
    expect(screen.queryByText("ACTIVITY")).toBeNull();
    expect(screen.queryByText("LIFECYCLE")).toBeNull();
  });
});
