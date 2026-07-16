import { describe, it, expect } from "vitest";
import { teamRoleStreams, SEEDABLE_TEAM_ROLES } from "./teamFleet";
import type { Persona } from "@/features/personas";
import type { SessionRole } from "@/shared/lib/session/sessionRoles";
import type { BlueprintTeam } from "../stages/blueprintTypes";
import type { Position } from "@/features/teams";

const persona = (id: string, role: SessionRole, name = id): Persona => ({
  id, name, blurb: "", role, startPrompt: "", skills: [],
});

// The library: one persona per interesting role.
const PERSONAS: Persona[] = [
  persona("persona-curator", "curator", "Curator"),
  persona("persona-documentor", "documentor", "Documentor"),
  persona("persona-reviewer", "reviewer", "Reviewer"),
  persona("persona-juror", "juror", "Auditor"),
  persona("persona-issuer", "issuer", "Intake"),
  persona("persona-marketer", "marketer", "Marketer"),
  persona("persona-worker", "worker", "Engineer"),
  persona("persona-director", "director", "Director"),
];

const agent = (nodeId: string, personaId: string, label?: string): Position =>
  ({ nodeId, kind: "agent", personaId, ...(label ? { label } : {}) });

const team = (positions: Position[]): BlueprintTeam => ({ positions, relationships: [] });

describe("teamRoleStreams (#3102)", () => {
  it("seeds one stream per seedable role-actor position, persona set, empty owns/issues/repo", () => {
    const t = team([
      agent("curator", "persona-curator"),
      agent("scribe", "persona-documentor", "Scribe"),
    ]);
    const out = teamRoleStreams(t, PERSONAS, []);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "curator", name: "Curator", persona: "persona-curator", repo: "", owns: [], issues: [], dependsOn: [] });
    // name prefers the position label over the persona name.
    expect(out[1]).toMatchObject({ id: "scribe", name: "Scribe", persona: "persona-documentor" });
  });

  it("covers every seedable role and NOTHING else — workers/director are not seeded", () => {
    // A position for each seedable role plus a worker + a director (must be skipped).
    const positions = [
      agent("c", "persona-curator"), agent("d", "persona-documentor"), agent("r", "persona-reviewer"),
      agent("j", "persona-juror"), agent("i", "persona-issuer"),
      agent("w", "persona-worker"), agent("dir", "persona-director"),
    ];
    const roles = new Set(teamRoleStreams(team(positions), PERSONAS, []).map((s) => PERSONAS.find((p) => p.id === s.persona)!.role));
    // reviewer/tester/juror/issuer/documentor/curator — minus tester (no position here) = 5.
    expect(roles).toEqual(new Set(["curator", "documentor", "reviewer", "juror", "issuer"]));
    expect(roles.has("worker")).toBe(false);
    expect(roles.has("director")).toBe(false);
    // The seedable set is the seven lifecycle actors; the marketer is opt-in (#3143) — seeds only when a
    // team explicitly places one (Fleet Alpha does), never a default like the others.
    expect(SEEDABLE_TEAM_ROLES).toEqual(new Set(["curator", "documentor", "reviewer", "tester", "juror", "issuer", "marketer"]));
  });

  it("seeds a marketer stream when the team places one (#3143 — opt-in, so it launches with the fleet)", () => {
    const t = team([agent("marketer", "persona-marketer", "Marketer"), agent("w", "persona-worker")]);
    const out = teamRoleStreams(t, PERSONAS, []);
    // The marketer is seeded (it's in SEEDABLE_TEAM_ROLES now); the worker is not (planner-owned).
    expect(out.map((s) => s.persona)).toEqual(["persona-marketer"]);
    expect(out[0]).toMatchObject({ id: "marketer", name: "Marketer", persona: "persona-marketer", repo: "", owns: [] });
  });

  it("ignores external/resource positions and unknown/absent persona ids", () => {
    const t: BlueprintTeam = {
      positions: [
        { nodeId: "commons", kind: "resource", label: "Commons" },
        { nodeId: "customer", kind: "external", label: "Customer" },
        { nodeId: "ghost", kind: "agent", personaId: "persona-nonexistent" },
        { nodeId: "empty", kind: "agent" }, // no personaId
        agent("curator", "persona-curator"),
      ],
      relationships: [],
    };
    const out = teamRoleStreams(t, PERSONAS, []);
    expect(out.map((s) => s.persona)).toEqual(["persona-curator"]);
  });

  it("does NOT re-seed a role the planner already streams (planner wins)", () => {
    const t = team([agent("curator", "persona-curator"), agent("scribe", "persona-documentor")]);
    // The planner already has a documentor stream → only the curator is seeded from the team.
    const out = teamRoleStreams(t, PERSONAS, [{ persona: "persona-documentor" }]);
    expect(out.map((s) => s.persona)).toEqual(["persona-curator"]);
  });

  it("dedupes a role appearing twice in the team (singletons — first position wins)", () => {
    const t = team([agent("cur-a", "persona-curator"), agent("cur-b", "persona-curator")]);
    const out = teamRoleStreams(t, PERSONAS, []);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("cur-a");
  });

  it("slugs a messy nodeId into a branch/pane-safe stream id", () => {
    const t = team([agent("Curator Bot!!", "persona-curator")]);
    expect(teamRoleStreams(t, PERSONAS, [])[0].id).toBe("curator-bot");
  });

  it("is deterministic (author order) and empty for no/undefined team", () => {
    expect(teamRoleStreams(undefined, PERSONAS, [])).toEqual([]);
    expect(teamRoleStreams(team([]), PERSONAS, [])).toEqual([]);
    const t = team([agent("r", "persona-reviewer"), agent("c", "persona-curator")]);
    expect(teamRoleStreams(t, PERSONAS, []).map((s) => s.id)).toEqual(["r", "c"]);
  });
});
