import { describe, it, expect } from "vitest";
import {
  BUILTIN_ORGS, COMMUNICATION_FORMS, RELATIONSHIP_ARCHETYPES,
  makeBuiltinOrgs, reconcileOrgs, orgStructureKey, blankOrg, orgSlug, orgIssues, deriveCommunication,
  archetypeById, formById, augmentStudioNetworkForRequests, STUDIO_NETWORK_ID, type Team,
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

  it("Fleet Alpha is the curated build fleet — its role-actors seed + launch, tester/documentor don't (#3143)", () => {
    const fleet = makeBuiltinOrgs().find((o) => o.id === "org-default-fleet")!;
    const personaIds = new Set(fleet.positions.filter((p) => p.kind === "agent").map((p) => p.personaId));
    // The team drives the fleet (#3101): each member role-actor the launch seeds is present. #3143 curated
    // this down — workers own their own testing + docs, so no tester/documentor actor; the auditor is the
    // real compliance persona; the marketer is opt-in but placed here so it launches with the fleet.
    for (const id of ["persona-director", "persona-worker", "persona-reviewer", "persona-auditor", "persona-issuer", "persona-curator", "persona-marketer"]) {
      expect(personaIds.has(id), `default team is missing ${id}`).toBe(true);
    }
    // The dropped actors (workers self-serve) are NOT members.
    for (const id of ["persona-tester", "persona-documentor"]) {
      expect(personaIds.has(id), `default team should not carry ${id}`).toBe(false);
    }
    // Exactly one engineer slot — the planner sizes the real count (#3143), so no fixed engineer count.
    expect(fleet.positions.filter((p) => p.personaId === "persona-worker")).toHaveLength(1);
    // Structurally clean (no dangling edges / unknown archetypes) with the iterates compliance loop.
    expect(orgIssues(fleet)).toEqual([]);
    expect(fleet.relationships.some((r) => r.archetype === "iterates" && r.from === "auditor")).toBe(true);
  });

  it("every built-in org is structurally clean — no dangling edges / unknown archetypes", () => {
    for (const o of makeBuiltinOrgs()) {
      expect(orgIssues(o), `${o.id} has structural issues`).toEqual([]);
    }
  });

  it("includes the Studio Network (#2940/#3317) — the four studio sessions, each serving + stewarding", () => {
    const studio = makeBuiltinOrgs().find((o) => o.id === "org-planning-studio")!;
    expect(studio).toBeTruthy();
    expect(studio.builtin).toBe(true);
    // The four app-owned studio sessions (planner · designer · librarian · architect) + their libraries.
    expect(studio.positions.map((p) => p.personaId)).toEqual(
      expect.arrayContaining(["persona-planner", "persona-designer", "persona-librarian", "persona-architect"]),
    );
    expect(studio.positions.filter((p) => p.kind === "resource").length).toBeGreaterThanOrEqual(3);
    const serves = (from: string, to: string) =>
      studio.relationships.some((r) => r.archetype === "serves" && r.from === from && r.to === to);
    const stewards = (from: string, to: string) =>
      studio.relationships.some((r) => r.archetype === "stewards" && r.from === from && r.to === to);
    // designer/librarian SERVE the planner (commissions → fulfilled); the librarian also serves the
    // designer (the algorithms-drive-previews payoff).
    expect(serves("designer", "planner")).toBe(true);
    expect(serves("librarian", "planner")).toBe(true);
    expect(serves("librarian", "designer")).toBe(true);
    // each STEWARDS only its own library (designer bsc ui, librarian bsc graph, architect the teams).
    expect(stewards("designer", "library")).toBe(true);
    expect(stewards("librarian", "algorithms")).toBe(true);
    expect(stewards("architect", "teams")).toBe(true);
  });

  // ── #debug-nodes-hang-off-the-session-that-filed-them ──────────────────────────────────────────
  //
  // The standing `debugger` node is GONE, and with it the test that asserted a toggle added it. What
  // replaced it is per-request nodes edged to WHOEVER FILED the request — the thing the old
  // augmentation could not express, because it hardwired every request's edge to `designer`.

  const studio = () => makeBuiltinOrgs().find((o) => o.id === STUDIO_NETWORK_ID)!;

  // The REAL pane ids (`design-studio:designer-react`, not `designer-studio:react`) — see the note on
  // `OriginHostResolver`. The resolver itself is injected and lives in `studioProject`, where it inverts
  // the authoritative node↔session table; this stand-in models the same contract so the AUGMENT's own
  // behaviour (labels, clustering, skipping) is tested without reaching into a glance module.
  const host = (origin: string | null | undefined, present: ReadonlySet<string>): string | null => {
    const map: Record<string, string> = {
      "design-studio:designer-react": "designer",
      "algorithms-studio:librarian-typescript": "librarian",
    };
    const node = map[(origin ?? "").trim()];
    return node && present.has(node) ? node : null;
  };

  it("adds one labelled node per request, edged to the session that FILED it", () => {
    const g = augmentStudioNetworkForRequests(studio(), [
      { id: 85, origin: "design-studio:designer-react", title: "ui list needs --kit" },
      { id: 102, origin: "algorithms-studio:librarian-typescript", title: "impl list needs --domain" },
    ], host);
    // The label is what makes a graph of several readable at a glance.
    expect(g.positions.find((p) => p.nodeId === "debugger-req-85")!.label).toBe("debug - ui list needs --kit");
    // …and the edge is the whole point: the librarian's request must NOT draw to the designer.
    const to = (id: string) => g.relationships.find((r) => r.from === id)!.to;
    expect(to("debugger-req-85")).toBe("designer");
    expect(to("debugger-req-102")).toBe("librarian");
  });

  it("clusters several requests from ONE session under that session", () => {
    const g = augmentStudioNetworkForRequests(studio(), [
      { id: 85, origin: "design-studio:designer-react", title: "a" },
      { id: 86, origin: "design-studio:designer-react", title: "b" },
    ], host);
    expect(g.relationships.filter((r) => r.to === "designer" && r.from.startsWith("debugger-req-"))).toHaveLength(2);
    // Fanned apart rather than stacked on one point — two nodes at one coordinate read as one node.
    const xs = ["debugger-req-85", "debugger-req-86"].map((id) => g.positions.find((p) => p.nodeId === id)!.x);
    expect(new Set(xs).size).toBe(2);
  });

  it("SKIPS a request whose origin has no position here rather than parenting it wrongly", () => {
    // A director-filed request (the one non-studio filer) belongs in its project's drill. Attaching it
    // to a default node would assert a relationship that does not exist; leaving it unparented reads as
    // a bug. Both are worse than omitting it here — and it IS drawn, in that project's own drill.
    const g = augmentStudioNetworkForRequests(studio(), [{ id: 7, origin: "myproject:director", title: "x" }], host);
    expect(g.positions.some((p) => p.nodeId === "debugger-req-7")).toBe(false);
  });

  // The counterpart, and the reason the two cases had to be split: this one is NOT claimed by any other
  // graph, so skipping it left a running session with no node ANYWHERE — unwatchable and unstoppable,
  // which is the single thing every request node exists to prevent. Requests filed before
  // `bsc request new` began stamping `$BSC_AUDIT_PANE` are exactly this shape.
  it("DRAWS a request with no origin at all — unparented, because nothing else can host it", () => {
    const g = augmentStudioNetworkForRequests(studio(), [{ id: 8, origin: null, title: "y" }], host);
    const node = g.positions.find((p) => p.nodeId === "debugger-req-8");
    expect(node).toBeDefined();
    expect(node!.label).toBe("debug - y");
    // No edge: there is genuinely nobody to point at, and inventing one is the failure the resolver exists
    // to end. An unparented node is honest; a wrongly-parented one is a lie the user cannot see through.
    expect(g.relationships.some((r) => r.from === "debugger-req-8" || r.to === "debugger-req-8")).toBe(false);
    // Below every drawn position, so it reads as "extra" instead of landing on top of somebody.
    const lowest = Math.max(...studio().positions.map((p) => p.y ?? 0));
    expect(node!.y!).toBeGreaterThan(lowest);
  });

  it("fans SEVERAL unparented requests apart instead of stacking them on one point", () => {
    const g = augmentStudioNetworkForRequests(studio(), [
      { id: 8, origin: null, title: "a" },
      { id: 9, origin: "   ", title: "b" }, // blank is "nobody said", same as absent
    ], host);
    const xs = ["debugger-req-8", "debugger-req-9"].map((id) => g.positions.find((p) => p.nodeId === id)!.x);
    expect(new Set(xs).size).toBe(2);
  });

  it("keeps hosted and unparented requests in SEPARATE layout rows", () => {
    // One shared counter would have pushed the unparented node sideways by however many hosted ones came
    // first, which is a layout that says a relationship the graph does not draw.
    const g = augmentStudioNetworkForRequests(studio(), [
      { id: 85, origin: "design-studio:designer-react", title: "a" },
      { id: 8, origin: null, title: "b" },
    ], host);
    const designer = studio().positions.find((p) => p.nodeId === "designer")!;
    const hosted = g.positions.find((p) => p.nodeId === "debugger-req-85")!;
    const orphan = g.positions.find((p) => p.nodeId === "debugger-req-8")!;
    expect(hosted.x).toBe((designer.x ?? 0) - 48); // first in ITS row, not the second in a shared one
    expect(orphan.x).toBe(96 - 48);
  });

  it("is idempotent, and a no-op with no requests or off the Studio Network", () => {
    const s = studio();
    expect(augmentStudioNetworkForRequests(s, [], host)).toBe(s);
    const fleet = makeBuiltinOrgs().find((o) => o.id === "org-default-fleet")!;
    const one = [{ id: 1, origin: "design-studio:designer-react", title: "z" }];
    expect(augmentStudioNetworkForRequests(fleet, one, host)).toBe(fleet);
    const nine = [{ id: 9, origin: "design-studio:designer-react", title: "z" }];
    const once = augmentStudioNetworkForRequests(s, nine, host);
    expect(augmentStudioNetworkForRequests(once, nine, host)
      .positions.filter((p) => p.nodeId === "debugger-req-9")).toHaveLength(1);
  });
});

describe("deriveCommunication (#2193)", () => {
  const fleet = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;

  it("derives a manager's outgoing directives + incoming escalations from the graph", () => {
    const comms = deriveCommunication(fleet, "director");
    // The director MANAGES the engineer → sends directives/decisions down, receives escalations/reports up.
    const sends = comms.filter((c) => c.dir === "out").map((c) => c.form.id);
    const gets = comms.filter((c) => c.dir === "in").map((c) => c.form.id);
    expect(sends).toContain("directive");
    expect(gets).toContain("escalation");
    // Every derived edge names a real counterpart node.
    expect(comms.every((c) => fleet.positions.some((p) => p.nodeId === c.withNode))).toBe(true);
  });

  it("orients an archetype's forward/backward lanes by which end the node is on", () => {
    // The engineer is the REPORT end of `manages` (director → engineer): its lanes are the mirror image.
    const worker = deriveCommunication(fleet, "engineer");
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

  it("makes a built-in's STRUCTURE packaged-authoritative — a stale on-disk copy can't shadow it (#3330)", () => {
    // A built-in frozen on disk at an OLD version (here: renamed + emptied of positions/relationships, the
    // exact shape of the stale org-planning-studio seed) must be REPLACED by the packaged def, so app updates
    // to a built-in team reach every install. (Old behavior kept the stale saved copy → updates never landed.)
    const base = BUILTIN_ORGS.find((o) => o.id === "org-default-fleet")!;
    const persisted: Team[] = [
      { id: "org-default-fleet", name: "Old name", positions: [], relationships: [], builtin: true },
    ];
    const fleet = reconcileOrgs(persisted).find((o) => o.id === "org-default-fleet")!;
    expect(fleet.name).toBe(base.name);                       // packaged name wins, not the stale "Old name"
    expect(fleet.positions).toEqual(base.positions);          // packaged structure restored
    expect(fleet.relationships).toEqual(base.relationships);
    expect(fleet.builtin).toBe(true);
  });

  it("keeps user-authored orgs (non-built-in ids) untouched, as non-builtin", () => {
    const persisted: Team[] = [{ id: "org-mine", name: "Mine", positions: [], relationships: [] }];
    const out = reconcileOrgs(persisted);
    const mine = out.find((o) => o.id === "org-mine")!;
    expect(mine.name).toBe("Mine");
    expect(mine.builtin).toBe(false);
    // ...and the built-ins are still all present alongside it.
    expect(out.filter((o) => o.builtin).length).toBe(BUILTIN_ORGS.length);
  });
});

describe("orgStructureKey (#3330)", () => {
  it("is equal for structurally-identical teams and differs when positions/relationships/name/blurb change", () => {
    const a = BUILTIN_ORGS.find((o) => o.id === STUDIO_NETWORK_ID)!;
    expect(orgStructureKey(a)).toBe(orgStructureKey({ ...a }));
    expect(orgStructureKey(a)).not.toBe(orgStructureKey({ ...a, name: "Renamed" }));
    expect(orgStructureKey(a)).not.toBe(orgStructureKey({ ...a, positions: a.positions.slice(0, 1) }));
    expect(orgStructureKey(a)).not.toBe(orgStructureKey({ ...a, relationships: [] }));
    // The builtin flag / id are NOT part of the structure key (they're constants, not authored drift).
    expect(orgStructureKey(a)).toBe(orgStructureKey({ ...a, builtin: false, id: "whatever" }));
  });
});

describe("archetypeById", () => {
  it("resolves a known archetype and returns undefined otherwise", () => {
    expect(archetypeById("manages")?.label).toBe("Manages");
    expect(archetypeById("nope")).toBeUndefined();
  });
});

