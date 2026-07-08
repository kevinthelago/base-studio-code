// Drill-aware legend (#2561): the ROLE/EDGE columns speak the project-network vocabulary at the root
// and the fleet's Org grammar (agent FUNCTION groups + relationship archetypes) when drilled.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GlanceOverlays } from "./GlanceCanvas";

describe("GlanceOverlays legend (#2561)", () => {
  it("L0 (no drill): project-network vocabulary — ROLE + the relabelled 'depends on' edge (never 'API contract')", () => {
    render(<GlanceOverlays />);
    expect(screen.getByText("ROLE")).toBeTruthy();
    expect(screen.getByText("EDGE")).toBeTruthy();
    expect(screen.getByText("depends on")).toBeTruthy();
    expect(screen.getByText("data flow")).toBeTruthy();
    expect(screen.queryByText("API contract")).toBeNull();
  });

  it("L1 (drill): FUNCTION groups + the Org archetypes present in the drilled fleet", () => {
    render(<GlanceOverlays drill archetypes={["manages", "oversees"]} />);
    expect(screen.getByText("FUNCTION")).toBeTruthy();
    expect(screen.getByText("orchestrate")).toBeTruthy();
    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.getByText("RELATIONSHIP")).toBeTruthy();
    expect(screen.getByText("Manages")).toBeTruthy();   // archetype label from the Org vocabulary
    expect(screen.getByText("Oversees")).toBeTruthy();
    // the L0 ROLE label is not shown while drilled
    expect(screen.queryByText("ROLE")).toBeNull();
  });
});
