// Blueprint team (#2450) — fork-on-attach isolation + the immutable edit helpers.
import { describe, it, expect } from "vitest";
import { BUILTIN_ORGS, type Org } from "@/features/org";
import {
  blankTeam, forkTeamFromOrg, teamAsOrg,
  teamAddPosition, teamUpdatePosition, teamRemovePosition,
  teamAddRelationship, teamUpdateRelationship, teamRemoveRelationship, teamApplyLayout,
} from "./blueprintTeam";

const libOrg = (): Org => ({
  id: "org-lib", name: "Library org", blurb: "the archetype",
  positions: [
    { nodeId: "n1", kind: "agent", personaId: "persona-director", x: 10, y: 20 },
    { nodeId: "n2", kind: "agent", personaId: "persona-worker", x: 200, y: 20 },
    { nodeId: "n3", kind: "resource", label: "Commons", x: 100, y: 200 },
  ],
  relationships: [
    { id: "r1", archetype: "manages", from: "n1", to: "n2" },
    { id: "r2", archetype: "stewards", from: "n1", to: "n3", bow: 30 },
  ],
});

describe("forkTeamFromOrg — fork-on-attach (#2450)", () => {
  it("deep-copies the org's graph (equal content, zero shared references) and drops library identity", () => {
    const org = libOrg();
    const team = forkTeamFromOrg(org);
    // Same content…
    expect(team.positions).toEqual(org.positions);
    expect(team.relationships).toEqual(org.relationships);
    // …but no shared objects at any level.
    expect(team.positions).not.toBe(org.positions);
    expect(team.relationships).not.toBe(org.relationships);
    team.positions.forEach((p, i) => expect(p).not.toBe(org.positions[i]));
    team.relationships.forEach((r, i) => expect(r).not.toBe(org.relationships[i]));
    // The library identity fields don't travel.
    expect(team).not.toHaveProperty("id");
    expect(team).not.toHaveProperty("name");
    expect(team).not.toHaveProperty("blurb");
    expect(team).not.toHaveProperty("builtin");
  });

  it("editing the blueprint's team never mutates the library org", () => {
    const org = libOrg();
    const snapshot = structuredClone(org);
    let team = forkTeamFromOrg(org);
    team = teamUpdatePosition(team, "n1", { x: 999, y: 999, personaId: "persona-other" });
    team = teamRemovePosition(team, "n2");
    team = teamAddRelationship(team, { id: "r-new", archetype: "peers", from: "n1", to: "n3" });
    expect(team.relationships.some((r) => r.id === "r-new")).toBe(true); // the edits landed…
    expect(org).toEqual(snapshot); // …and the library org is byte-identical
  });

  it("editing the library org never ripples into an already-forked team", () => {
    const org = libOrg();
    const team = forkTeamFromOrg(org);
    const snapshot = structuredClone(team);
    // A store-style in-place mutation of the library side (worst case).
    org.positions[0].x = -1;
    org.positions[0].personaId = "persona-mutated";
    org.relationships[0].archetype = "serves";
    org.positions.push({ nodeId: "n9", kind: "agent" });
    expect(team).toEqual(snapshot); // the fork is untouched
  });

  it("forks every packaged built-in cleanly (the archetype library use-case)", () => {
    for (const org of BUILTIN_ORGS) {
      const team = forkTeamFromOrg(org);
      expect(team.positions).toEqual(org.positions);
      expect(team.relationships).toEqual(org.relationships);
      expect(team.positions).not.toBe(org.positions);
    }
  });
});

describe("blueprintTeam helpers", () => {
  it("blankTeam is an empty graph", () => {
    expect(blankTeam()).toEqual({ positions: [], relationships: [] });
  });

  it("teamAsOrg wraps the team as a synthetic Org lens (shared arrays, synthetic identity)", () => {
    const team = forkTeamFromOrg(libOrg());
    const asOrg = teamAsOrg(team, "My blueprint");
    expect(asOrg.name).toBe("My blueprint");
    // A read LENS: it shares the team's arrays (not a copy — the canvas reads live edits).
    expect(asOrg.positions).toBe(team.positions);
    expect(asOrg.relationships).toBe(team.relationships);
  });

  it("edit helpers are immutable and keep identity fields fixed", () => {
    const team = forkTeamFromOrg(libOrg());
    const withPos = teamAddPosition(team, { nodeId: "n4", kind: "external", label: "Customer" });
    expect(withPos.positions).toHaveLength(4);
    expect(team.positions).toHaveLength(3); // source untouched

    // nodeId / relationship id are immutable through a patch.
    const moved = teamUpdatePosition(withPos, "n4", { x: 5, y: 6, nodeId: "hax" } as never);
    expect(moved.positions.find((p) => p.label === "Customer")).toMatchObject({ nodeId: "n4", x: 5, y: 6 });
    const rearch = teamUpdateRelationship(team, "r1", { archetype: "peers", id: "hax" } as never);
    expect(rearch.relationships.find((r) => r.archetype === "peers")!.id).toBe("r1");

    const dropped = teamRemoveRelationship(team, "r2");
    expect(dropped.relationships.map((r) => r.id)).toEqual(["r1"]);
  });

  it("removing a position cascades to every relationship touching it", () => {
    const team = forkTeamFromOrg(libOrg());
    const out = teamRemovePosition(team, "n1"); // n1 is on both edges
    expect(out.positions.map((p) => p.nodeId)).toEqual(["n2", "n3"]);
    expect(out.relationships).toEqual([]);
  });

  it("teamApplyLayout stamps coords onto matching positions and leaves the rest", () => {
    const team = forkTeamFromOrg(libOrg());
    const out = teamApplyLayout(team, { n1: { x: 1, y: 2 }, n3: { x: 3, y: 4 } });
    expect(out.positions.find((p) => p.nodeId === "n1")).toMatchObject({ x: 1, y: 2 });
    expect(out.positions.find((p) => p.nodeId === "n2")).toMatchObject({ x: 200, y: 20 }); // untouched
    expect(out.positions.find((p) => p.nodeId === "n3")).toMatchObject({ x: 3, y: 4 });
  });
});
