// Team author view (#2450) — the archetype picker (fork-on-attach) + the org designer canvas
// bound to `blueprint.team`.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TeamView } from "./TeamView";
import { useAppStore } from "@/store";
import type { Blueprint, BlueprintTeam } from "@/features/planner/stages/blueprints";
import type { Org } from "@/features/org";

const libOrg: Org = {
  id: "org-test", name: "Test archetype", blurb: "a two-agent fleet",
  positions: [
    { nodeId: "n1", kind: "agent", label: "Director", x: 40, y: 40 },
    { nodeId: "n2", kind: "agent", label: "Engineer", x: 300, y: 40 },
  ],
  relationships: [{ id: "r1", archetype: "manages", from: "n1", to: "n2" }],
};

const bp = (team?: BlueprintTeam): Blueprint => ({
  id: "bp-x", name: "My blueprint", desc: "", sections: [], ...(team ? { team } : {}),
});

beforeEach(() => {
  useAppStore.setState({ orgs: [libOrg] });
});

describe("TeamView — archetype picker (fork-on-attach, #2450)", () => {
  it("lists the org library + start blank when the blueprint has no team", () => {
    render(<TeamView bp={bp()} onChange={() => {}} />);
    expect(screen.getByText("Test archetype")).toBeTruthy();
    expect(screen.getByText("Start blank")).toBeTruthy();
  });

  it("picking an archetype forks it into blueprint.team — a deep copy, never the library objects", () => {
    const onChange = vi.fn();
    render(<TeamView bp={bp()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("team-archetype-org-test"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Blueprint;
    // Equal graph content, dropped library identity…
    expect(next.team).toEqual({ positions: libOrg.positions, relationships: libOrg.relationships });
    expect(next.team).not.toHaveProperty("id");
    // …and zero shared references with the library org (the fork isolation boundary).
    expect(next.team!.positions).not.toBe(libOrg.positions);
    expect(next.team!.positions[0]).not.toBe(libOrg.positions[0]);
    expect(next.team!.relationships[0]).not.toBe(libOrg.relationships[0]);
  });

  it("start blank attaches an empty team", () => {
    const onChange = vi.fn();
    render(<TeamView bp={bp()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("team-archetype-blank"));
    expect((onChange.mock.calls[0][0] as Blueprint).team).toEqual({ positions: [], relationships: [] });
  });
});

describe("TeamView — team editor", () => {
  const team = (): BlueprintTeam => ({
    positions: [
      { nodeId: "n1", kind: "agent", label: "Director", x: 40, y: 40 },
      { nodeId: "n2", kind: "agent", label: "Engineer" }, // no coords yet
    ],
    relationships: [{ id: "r1", archetype: "manages", from: "n1", to: "n2" }],
  });

  it("renders the canvas editor over blueprint.team (positions rail + toolbar)", () => {
    render(<TeamView bp={bp(team())} onChange={() => {}} />);
    // The rail lists the team's positions (label-driven display), and the org toolbar verbs are up.
    expect(screen.getAllByText("Director").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Engineer").length).toBeGreaterThan(0);
    expect(screen.getByText(/Auto organize/)).toBeTruthy();
    expect(screen.getByText("2 positions · 1 rels")).toBeTruthy();
  });

  it("＋ new adds a position to the blueprint's team (not any library org)", () => {
    const onChange = vi.fn();
    render(<TeamView bp={bp(team())} onChange={onChange} />);
    fireEvent.click(screen.getByText("＋ new"));
    const next = onChange.mock.calls[0][0] as Blueprint;
    expect(next.team!.positions).toHaveLength(3);
    expect(next.team!.positions[2].kind).toBe("agent");
    expect(useAppStore.getState().orgs[0].positions).toHaveLength(2); // library untouched
  });

  it("auto-organize stamps layout coords onto every position via onChange", () => {
    const onChange = vi.fn();
    render(<TeamView bp={bp(team())} onChange={onChange} />);
    fireEvent.click(screen.getByText(/Auto organize/));
    const next = onChange.mock.calls[0][0] as Blueprint;
    for (const p of next.team!.positions) {
      expect(typeof p.x).toBe("number");
      expect(typeof p.y).toBe("number");
    }
  });

  it("selecting a position from the rail opens the inspector; delete removes it + its edges", () => {
    const onChange = vi.fn();
    render(<TeamView bp={bp(team())} onChange={onChange} />);
    // Click the rail row (the rail label is the first "Director" occurrence).
    fireEvent.click(screen.getAllByText("Director")[0]);
    const del = screen.getByRole("button", { name: /Delete position/ });
    fireEvent.click(del); // arms
    fireEvent.click(del); // confirms
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Blueprint;
    expect(next.team!.positions.map((p) => p.nodeId)).toEqual(["n2"]);
    expect(next.team!.relationships).toEqual([]); // the edge touching n1 cascaded away
  });

  it("restart (two-step confirm) discards the team and returns to the picker", () => {
    const onChange = vi.fn();
    render(<TeamView bp={bp(team())} onChange={onChange} />);
    const restart = screen.getByRole("button", { name: /restart/ });
    fireEvent.click(restart); // arms
    fireEvent.click(restart); // confirms
    const next = onChange.mock.calls[onChange.mock.calls.length - 1][0] as Blueprint;
    expect(next.team).toBeUndefined();
  });
});
