import { describe, it, expect } from "vitest";
import {
  BUILTIN_ORGS, COMMUNICATION_FORMS, RELATIONSHIP_ARCHETYPES,
  makeBuiltinOrgs, reconcileOrgs, blankOrg, orgSlug, orgIssues, deriveCommunication,
  archetypeById, formById, type Team,
} from "./team";

describe("org vocabulary (#2193)", () => {
  it("loads the communication forms + archetypes from @data/teams", () => {
    expect(COMMUNICATION_FORMS.length).toBeGreaterThanOrEqual(8);
    expect(RELATIONSHIP_ARCHETYPES.length).toBeGreaterThanOrEqual(6);
    // A blocking escalation and an authoritative directive exist, with their runtime semantics intact.
    const escalation = formById("escalation")!;
    expect(escalation.blocks).toBe(true);
    expect(escalation.transport).toBe("bsc-ask");
    expect(formById("directive")!.authority).toBe(true);
  });

  it("every archetype references only forms that exist in the vocabulary", () => {
    for (const a of RELATIONSHIP_ARCHETYPES) {
      for (const fid of [...a.forward, ...a.backward]) {
        expect(formById(fid), `archetype ${a.id} references unknown form ${fid}`).toBeTruthy();
      }
    }
  });

  it("the `iterates` archetype (#2578) is the one CYCLICAL feedback loop, with finding ⟳ revision forms", () => {
    const iterates = archetypeById("iterates")!;
    expect(iterates.cyclical).toBe(true);
    expect(iterates.bidirectional).toBe(true);
    expect(iterates.forward).toContain("finding");
    expect(iterates.backward).toContain("revision");
    // its forms resolve and carry the runtime transports that drive the loop
    expect(formById("finding")!.transport).toBe("bsc-issue");
    expect(formById("revision")!.transport).toBe("bsc-landed");
    // it is the ONLY cyclical archetype — every other relationship stays acyclic (a DAG edge).
    expect(RELATIONSHIP_ARCHETYPES.filter((a) => a.cyclical).map((a) => a.id)).toEqual(["iterates"]);
  });
});

describe("built-in orgs (#2193)", () => {
  it("assembles the Default fleet from @data/teams/orgs, flagged builtin + well-formed", () => {
    const built = makeBuiltinOrgs();
    const fleet = built.find((o) => o.id === "org-default-fleet")!;
    expect(fleet).toBeTruthy();
    expect(fleet.builtin).toBe(true);
    // `order` is load-time-only — it must not leak onto the assembled Team.
    expect("order" in fleet).toBe(false);
    // The graph is structurally clean: no dangling edges, no unknown archetypes.
    expect(orgIssues(fleet)).toEqual([]);
    // The manager→report + serves(external customer) + oversees(gate) shape is present.
    expect(fleet.relationships.some((r) => r.archetype === "manages")).toBe(true);
    expect(fleet.positions.some((p) => p.kind === "external")).toBe(true);
    expect(fleet.positions.some((p) => p.kind === "resource")).toBe(true);
  });

  it("Fleet Alpha is the complete optimal roster — every seedable role-actor is a member (#3104)", () => {
    const fleet = makeBuiltinOrgs().find((o) => o.id === "org-default-fleet")!;
    const personaIds = new Set(fleet.positions.filter((p) => p.kind === "agent").map((p) => p.personaId));
    // The team drives the fleet (#3101): each lifecycle role-actor the launch seeds from a team must be
    // a member of the packaged default team, so a standard project spins up the full roster.
    for (const id of ["persona-curator", "persona-documentor", "persona-reviewer", "persona-tester", "persona-juror", "persona-issuer"]) {
      expect(personaIds.has(id), `default team is missing ${id}`).toBe(true);
    }
    // Still structurally clean with the added positions + steward/oversee edges (no dangling/unknown).
    expect(orgIssues(fleet)).toEqual([]);
  });

  it("every built-in org is structurally clean — no dangling edges / unknown archetypes", () => {
    for (const o of makeBuiltinOrgs()) {
      expect(orgIssues(o), `${o.id} has structural issues`).toEqual([]);
    }
  });

  it("includes the Planning Studio network (#2940) — the designer serves the planner and stewards the library", () => {
    const studio = makeBuiltinOrgs().find((o) => o.id === "org-planning-studio")!;
    expect(studio).toBeTruthy();
    expect(studio.builtin).toBe(true);
    // planner (requester) + designer (provider/steward) + the shared component-library resource
    expect(studio.positions.map((p) => p.personaId)).toEqual(
      expect.arrayContaining(["persona-planner", "persona-designer"]),
    );
    expect(studio.positions.some((p) => p.kind === "resource")).toBe(true);
    // the designer SERVES the planner (component requests → fulfilled) and STEWARDS the shared library
    expect(
      studio.relationships.some((r) => r.archetype === "serves" && r.from === "designer" && r.to === "planner"),
    ).toBe(true);
    expect(
      studio.relationships.some((r) => r.archetype === "stewards" && r.from === "designer" && r.to === "library"),
    ).toBe(true);
  });
});

describe("deriveCommunication (#2193)", () => {
  const fleet = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;

  it("derives a manager's outgoing directives + incoming escalations from the graph", () => {
    const comms = deriveCommunication(fleet, "director");
    // The director MANAGES worker-a → sends directives/decisions down, receives escalations/reports up.
    const sends = comms.filter((c) => c.dir === "out").map((c) => c.form.id);
    const gets = comms.filter((c) => c.dir === "in").map((c) => c.form.id);
    expect(sends).toContain("directive");
    expect(gets).toContain("escalation");
    // Every derived edge names a real counterpart node.
    expect(comms.every((c) => fleet.positions.some((p) => p.nodeId === c.withNode))).toBe(true);
  });

  it("orients an archetype's forward/backward lanes by which end the node is on", () => {
    // worker-a is the REPORT end of `manages` (director → worker-a): its lanes are the mirror image.
    const worker = deriveCommunication(fleet, "worker-a");
    expect(worker.filter((c) => c.dir === "out").map((c) => c.form.id)).toContain("escalation");
    expect(worker.filter((c) => c.dir === "in").map((c) => c.form.id)).toContain("directive");
  });
});

describe("orgIssues (#2193)", () => {
  it("flags a dangling edge and an unknown archetype", () => {
    const bad: Team = {
      id: "x", name: "x",
      positions: [{ nodeId: "a", kind: "agent" }],
      relationships: [
        { id: "e1", archetype: "manages", from: "a", to: "ghost" },
        { id: "e2", archetype: "nope", from: "a", to: "a" },
      ],
    };
    const issues = orgIssues(bad);
    expect(issues.some((i) => i.includes("ghost"))).toBe(true);
    expect(issues.some((i) => i.includes("nope"))).toBe(true);
  });
});

describe("orgSlug / blankOrg", () => {
  it("slugifies and never yields empty", () => {
    expect(orgSlug("My Fleet!")).toBe("my-fleet");
    expect(orgSlug("   ")).toBe("org");
  });
  it("blankOrg seeds an editable (non-builtin) empty org", () => {
    const o = blankOrg("org-x");
    expect(o).toMatchObject({ id: "org-x", positions: [], relationships: [] });
    expect(o.builtin).toBeUndefined();
  });
});

describe("reconcileOrgs (#2193)", () => {
  it("seeds all built-ins from an empty persisted set", () => {
    const out = reconcileOrgs([]);
    expect(out.length).toBe(BUILTIN_ORGS.length);
    expect(out.every((o) => o.builtin)).toBe(true);
  });

  it("preserves user edits to a built-in but restores builtin identity", () => {
    const persisted: Team[] = [
      { id: "org-default-fleet", name: "My fleet", positions: [], relationships: [], builtin: false },
    ];
    const fleet = reconcileOrgs(persisted).find((o) => o.id === "org-default-fleet")!;
    expect(fleet.name).toBe("My fleet");   // edit kept
    expect(fleet.builtin).toBe(true);      // identity restored — cannot become deletable
  });

  it("keeps user-authored orgs as non-builtin", () => {
    const persisted: Team[] = [{ id: "org-mine", name: "Mine", positions: [], relationships: [] }];
    const mine = reconcileOrgs(persisted).find((o) => o.id === "org-mine")!;
    expect(mine.builtin).toBe(false);
  });
});

describe("archetypeById", () => {
  it("resolves a known archetype and returns undefined otherwise", () => {
    expect(archetypeById("manages")?.label).toBe("Manages");
    expect(archetypeById("nope")).toBeUndefined();
  });
});
