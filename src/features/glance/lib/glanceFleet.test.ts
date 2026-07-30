import { describe, it, expect } from "vitest";
import { buildFleetData, buildOrgFleetData, buildRealFleetData, fleetToOrg, teamToOrg, nodeHasLiveSession, livePanesForProject, withPreviewNode, PREVIEW_NODE_ID } from "./glanceFleet";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Persona } from "@/features/personas";
import type { Team } from "@/features/teams";
import type { BlueprintTeam } from "@/features/planner/stages/blueprintTypes";

describe("buildFleetData (glance drill)", () => {
  it("builds a deterministic sample fleet: director + reviewer + 2–4 workers, all edges wired", () => {
    const a = buildFleetData({ id: "proj-x", name: "X" });
    expect(a).toEqual(buildFleetData({ id: "proj-x", name: "X" })); // deterministic per project
    expect(a.sample).toBe(true);

    const ids = a.rawNodes.map((n) => n.id);
    expect(ids).toContain("director");
    expect(ids).toContain("reviewer");
    const workers = a.rawNodes.filter((n) => n.id.startsWith("worker-"));
    expect(workers.length).toBeGreaterThanOrEqual(2);
    expect(workers.length).toBeLessThanOrEqual(4);

    // each worker is managed by the director and overseen by the reviewer (Org archetypes, #2561)
    for (const w of workers) {
      expect(a.rawEdges).toContainEqual({ from: w.id, to: "director", kind: "api", archetype: "manages" });
      expect(a.rawEdges).toContainEqual({ from: "reviewer", to: w.id, kind: "data", archetype: "oversees" });
    }
  });

  it("seeds an auditor ⟳ reviewer iteration loop (#2578) — both directions, so it reads as a cycle", () => {
    const a = buildFleetData({ id: "proj-x", name: "X" });
    expect(a.rawNodes.map((n) => n.id)).toContain("auditor");
    // both directions present + archetype `iterates` → mutualPairs will flag it as a loop
    expect(a.rawEdges).toContainEqual({ from: "auditor", to: "reviewer", kind: "data", archetype: "iterates" });
    expect(a.rawEdges).toContainEqual({ from: "reviewer", to: "auditor", kind: "data", archetype: "iterates" });
  });

  it("varies the worker count by project id", () => {
    const counts = new Set(
      ["a", "bb", "ccc", "dddd", "project-network", "ledger-svc"].map(
        (id) => buildFleetData({ id, name: id }).rawNodes.filter((n) => n.id.startsWith("worker-")).length,
      ),
    );
    expect(counts.size).toBeGreaterThan(1); // not all the same
  });
});

describe("buildRealFleetData (glance drill — real fleet)", () => {
  const personas: Persona[] = [
    { id: "p-worker", name: "Backend Engineer", blurb: "", role: "worker", startPrompt: "", skills: ["rust", "api"], model: "claude-sonnet-5", responsibilities: ["owns the API"] },
    { id: "p-reviewer", name: "Reviewer", blurb: "", role: "reviewer", startPrompt: "", skills: [] },
  ];
  const fleet = {
    recommended: 2, reasoning: "",
    streams: [
      { id: "api", name: "API", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-worker" },
      { id: "ui", name: "UI", repo: "r", owns: [], issues: [], dependsOn: ["api"], persona: "p-worker" },
      { id: "qa", name: "QA", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-reviewer" },
    ],
    director: { enabled: true },
    edges: [{ id: "e1", from: "api", to: "ui", kind: "handoff" as const, hardness: "blocking" as const, via: "direct" as const }],
  } as unknown as FleetPlan;

  it("maps streams→nodes (role via persona), a director hub, and coordination + dependsOn edges", () => {
    const d = buildRealFleetData(fleet, personas);
    expect(d.sample).toBe(false);
    const byId = Object.fromEntries(d.rawNodes.map((n) => [n.id, n]));
    expect(byId.api.role).toBe("service");   // worker → service (colour category)
    expect(byId.api.roleLabel).toBe("worker"); // real role carried for display
    expect(byId.qa.role).toBe("data");       // reviewer → data
    expect(byId.qa.roleLabel).toBe("reviewer");
    expect(byId.director.role).toBe("infra");// director hub added
    expect(byId.director.roleLabel).toBe("director");
    // director hub: each stream is MANAGED by the director (Org archetype #2561)
    expect(d.rawEdges).toContainEqual({ from: "api", to: "director", kind: "api", archetype: "manages" });
    // dependsOn + the handoff both resolve to a single ui→api PEERS edge (deduped)
    expect(d.rawEdges.filter((e) => e.from === "ui" && e.to === "api")).toEqual([{ from: "ui", to: "api", kind: "api", archetype: "peers" }]);
  });

  it("surfaces each stream's persona on its node (#2561): name · model · skills · responsibilities", () => {
    const d = buildRealFleetData(fleet, personas);
    const api = d.rawNodes.find((n) => n.id === "api")!;
    expect(api.persona).toMatchObject({ name: "Backend Engineer", role: "worker", model: "claude-sonnet-5", skills: ["rust", "api"], responsibilities: ["owns the API"] });
    expect(api.persona!.comms!.length).toBeGreaterThan(0); // its communication surface is attached (#2563)
    // a persona with no model/responsibilities resolves to empty arrays, not undefined holes
    const qa = d.rawNodes.find((n) => n.id === "qa")!;
    expect(qa.persona).toMatchObject({ name: "Reviewer", role: "reviewer", skills: [], responsibilities: [] });
  });

  it("tags the coordination edge with its Org archetype (review→oversees, handoff→peers)", () => {
    const withReview = { ...fleet, edges: [{ id: "e2", from: "api", to: "qa", kind: "review", hardness: "blocking", via: "direct" }] } as unknown as FleetPlan;
    const d = buildRealFleetData(withReview, personas);
    // review edge producer(api)→consumer(qa) becomes qa→api, archetype OVERSEES
    expect(d.rawEdges).toContainEqual({ from: "qa", to: "api", kind: "data", archetype: "oversees" });
  });
});

describe("fleetToOrg (#2563 — the fleet-as-Org projection)", () => {
  const fleet = {
    recommended: 2, reasoning: "",
    streams: [
      { id: "api", name: "API", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-worker" },
      { id: "ui", name: "UI", repo: "r", owns: [], issues: [], dependsOn: ["api"], persona: "p-worker" },
    ],
    director: { enabled: true },
    edges: [{ id: "e1", from: "api", to: "ui", kind: "handoff", hardness: "blocking", via: "direct" }],
  } as unknown as FleetPlan;

  it("projects streams (+ director) into positions and coordination into archetype relationships", () => {
    const org = fleetToOrg(fleet);
    expect(org.positions.map((p) => p.nodeId).sort()).toEqual(["api", "director", "ui"]);
    expect(org.positions.find((p) => p.nodeId === "api")).toMatchObject({ kind: "agent", personaId: "p-worker" });
    // the director MANAGES each stream
    expect(org.relationships).toContainEqual(expect.objectContaining({ from: "director", to: "api", archetype: "manages" }));
    expect(org.relationships).toContainEqual(expect.objectContaining({ from: "director", to: "ui", archetype: "manages" }));
    // the handoff + dependsOn between api and ui collapse to ONE peers seam
    expect(org.relationships.filter((r) => r.from === "api" && r.to === "ui")).toEqual([expect.objectContaining({ archetype: "peers" })]);
  });

  it("omits the director position + manages relationships when there is no director", () => {
    const org = fleetToOrg({ ...fleet, director: { enabled: false } });
    expect(org.positions.some((p) => p.nodeId === "director")).toBe(false);
    expect(org.relationships.some((r) => r.archetype === "manages")).toBe(false);
  });
});

describe("buildRealFleetData attaches each agent's communication surface (#2563)", () => {
  const personas: Persona[] = [{ id: "p-worker", name: "Backend Engineer", blurb: "", role: "worker", startPrompt: "", skills: [] }];
  const fleet = {
    recommended: 1, reasoning: "",
    streams: [{ id: "api", name: "API", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-worker" }],
    director: { enabled: true },
  } as unknown as FleetPlan;

  it("the director's persona lists a Manages relationship to each stream, SENDING a Directive", () => {
    const d = buildRealFleetData(fleet, personas);
    const toApi = d.rawNodes.find((n) => n.id === "director")!.persona!.comms!.find((c) => c.withName === "API");
    expect(toApi).toBeTruthy();
    expect(toApi!.archetypeLabel).toBe("Manages");
    expect(toApi!.sends.map((f) => f.label)).toContain("Directive");
  });

  it("the worker's persona lists the same relationship from its side — RECEIVING the Directive (with its bsc-* transport)", () => {
    const d = buildRealFleetData(fleet, personas);
    const fromDir = d.rawNodes.find((n) => n.id === "api")!.persona!.comms!.find((c) => c.withName === "director");
    expect(fromDir).toBeTruthy();
    const directive = fromDir!.receives.find((f) => f.label === "Directive");
    expect(directive).toBeTruthy();
    expect(directive!.transport).toBe("bsc-assign");
  });
});

describe("buildOrgFleetData (#2565 — render the drill FROM an Org)", () => {
  const personas: Persona[] = [{ id: "p-worker", name: "Backend Engineer", blurb: "", role: "worker", startPrompt: "", skills: [] }];
  const org: Team = {
    id: "o", name: "O",
    positions: [
      { nodeId: "api", kind: "agent", personaId: "p-worker", label: "API" },
      { nodeId: "director", kind: "agent", personaId: "director", label: "director" },
    ],
    relationships: [{ id: "r0", archetype: "manages", from: "director", to: "api" }],
  };

  it("maps positions→nodes (persona + comms) and REVERSES each relationship into a dependency edge", () => {
    const d = buildOrgFleetData(org, personas);
    expect(d.rawNodes.map((n) => n.id).sort()).toEqual(["api", "director"]);
    const api = d.rawNodes.find((n) => n.id === "api")!;
    expect(api.roleLabel).toBe("worker");
    expect(api.persona!.name).toBe("Backend Engineer");
    expect(api.persona!.comms!.length).toBeGreaterThan(0);
    // director MANAGES api ⇒ the Glance dependency edge is api → director (a report depends on its manager)
    expect(d.rawEdges).toEqual([{ from: "api", to: "director", kind: "api", archetype: "manages" }]);
  });

  it("buildRealFleetData routes through it — topology-preserving (director stays the foundational hub)", () => {
    const fleet = {
      recommended: 1, reasoning: "",
      streams: [{ id: "api", name: "API", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-worker" }],
      director: { enabled: true },
    } as unknown as FleetPlan;
    const d = buildRealFleetData(fleet, personas);
    expect(d.rawEdges).toContainEqual({ from: "api", to: "director", kind: "api", archetype: "manages" });
  });
});

describe("fleetToOrg team overlay + teamToOrg (#2572 — author the fleet as an Org)", () => {
  const fleet = {
    recommended: 2, reasoning: "",
    streams: [
      { id: "api", name: "API", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-a" },
      { id: "web", name: "Web", repo: "r", owns: [], issues: [], dependsOn: ["api"], persona: "p-b" },
    ],
    director: { enabled: false },
  } as unknown as FleetPlan;
  const team = {
    positions: [
      { nodeId: "n1", kind: "agent", personaId: "p-a" },
      { nodeId: "n2", kind: "agent", personaId: "p-b" },
    ],
    relationships: [{ id: "tr", archetype: "oversees", from: "n1", to: "n2" }],
  } as unknown as BlueprintTeam;

  it("no team ⇒ the coordination-derived archetype (peers) stands", () => {
    const org = fleetToOrg(fleet);
    expect(org.relationships.find((r) => r.from === "api" && r.to === "web")?.archetype).toBe("peers");
  });

  it("the authored team archetype (oversees) OVERRIDES the derived one for the matching persona pair + direction", () => {
    const org = fleetToOrg(fleet, team);
    expect(org.relationships.find((r) => r.from === "api" && r.to === "web")?.archetype).toBe("oversees");
  });

  it("teamToOrg wraps a team's positions + relationships into a standalone Org", () => {
    const org = teamToOrg(team);
    expect(org.positions).toBe(team.positions);
    expect(org.relationships).toBe(team.relationships);
    expect(org.name).toBe("Team");
  });
});

describe("fleetToOrg phase-2 team instantiation (#2575)", () => {
  it("ADDS an authored team relationship that has NO derived edge, instantiated onto the streams by persona", () => {
    const fleet = {
      recommended: 2, reasoning: "",
      streams: [
        { id: "api", name: "API", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-a" },
        { id: "web", name: "Web", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-b" },
      ],
      director: { enabled: false },
    } as unknown as FleetPlan;
    const team = {
      positions: [{ nodeId: "n1", kind: "agent", personaId: "p-a" }, { nodeId: "n2", kind: "agent", personaId: "p-b" }],
      relationships: [{ id: "tr", archetype: "oversees", from: "n1", to: "n2" }],
    } as unknown as BlueprintTeam;
    const org = fleetToOrg(fleet, team);
    // there was no derived edge between api & web; the authored oversees relationship is added
    expect(org.relationships).toContainEqual(expect.objectContaining({ from: "api", to: "web", archetype: "oversees" }));
    // without the team, no such edge exists
    expect(fleetToOrg(fleet).relationships.some((r) => r.from === "api" && r.to === "web")).toBe(false);
  });

  it("instantiates a team relationship across a POOLED persona (one team position → many streams)", () => {
    const fleet = {
      recommended: 3, reasoning: "",
      streams: [
        { id: "w1", name: "W1", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-worker" },
        { id: "w2", name: "W2", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-worker" },
        { id: "qa", name: "QA", repo: "r", owns: [], issues: [], dependsOn: [], persona: "p-rev" },
      ],
      director: { enabled: false },
    } as unknown as FleetPlan;
    const team = {
      positions: [{ nodeId: "rev", kind: "agent", personaId: "p-rev" }, { nodeId: "wk", kind: "agent", personaId: "p-worker" }],
      relationships: [{ id: "tr", archetype: "oversees", from: "rev", to: "wk" }],
    } as unknown as BlueprintTeam;
    const org = fleetToOrg(fleet, team);
    // the single reviewer oversees BOTH workers
    expect(org.relationships.filter((r) => r.archetype === "oversees" && r.from === "qa").map((r) => r.to).sort()).toEqual(["w1", "w2"]);
  });
});

describe("buildOrgFleetData cyclical archetype (#2578 — iteration loops)", () => {
  it("emits BOTH directions for a cyclical (iterates) relationship, one for every other archetype", () => {
    const org: Team = {
      id: "o", name: "O",
      positions: [
        { nodeId: "aud", kind: "agent", personaId: "persona-auditor", label: "auditor" },
        { nodeId: "wrk", kind: "agent", personaId: "persona-worker", label: "worker" },
        { nodeId: "dir", kind: "agent", personaId: "persona-director", label: "director" },
      ],
      relationships: [
        { id: "r0", archetype: "iterates", from: "aud", to: "wrk" }, // a LOOP → both directions
        { id: "r1", archetype: "manages", from: "dir", to: "wrk" },  // a DAG edge → one reversed edge
      ],
    };
    const data = buildOrgFleetData(org, []);
    const iter = data.rawEdges.filter((e) => e.archetype === "iterates");
    // the loop produced a mutual pair (aud↔wrk) — the shared cycle primitive will render it bowed
    expect(iter).toHaveLength(2);
    expect(new Set(iter.map((e) => `${e.from}->${e.to}`))).toEqual(new Set(["aud->wrk", "wrk->aud"]));
    // the DAG archetype stays a single (reversed) edge
    expect(data.rawEdges.filter((e) => e.archetype === "manages")).toHaveLength(1);
  });
});

describe("withPreviewNode (#2623 — the finished-app preview node)", () => {
  const base = { rawNodes: [{ id: "api", role: "service" as const, health: "off" as const, activity: "idle" as const }], rawEdges: [], sample: false };

  it("adds a distinct preview node ONLY when the project is complete", () => {
    expect(withPreviewNode(base, false).rawNodes.some((n) => n.preview)).toBe(false); // still building → no node
    const done = withPreviewNode(base, true);
    const preview = done.rawNodes.find((n) => n.preview);
    expect(preview).toMatchObject({ id: PREVIEW_NODE_ID, preview: true, activity: "live" });
    expect(done.rawNodes).toHaveLength(2); // the agent + the preview node
  });

  it("is idempotent — never adds a second preview node", () => {
    const once = withPreviewNode(base, true);
    expect(withPreviewNode(once, true).rawNodes.filter((n) => n.preview)).toHaveLength(1);
  });
});

describe("nodeHasLiveSession (#2534/#2542 — a fleet-tab cell morphs)", () => {
  // A launched build tab: the director + workers are all cells (paneIds), so all are openable.
  const live = new Set(["proj:director", "proj:foundation", "proj:pages-a"]);

  it("is live for a worker cell of the launched fleet tab", () => {
    expect(nodeHasLiveSession("proj:foundation", live)).toBe(true);
  });

  it("is live for the DIRECTOR cell — same durable tab-membership signal as workers (#2542)", () => {
    // The director isn't a stream (never in the roster) and sits idle between prompts, but it IS a
    // cell in the build tab, so it opens exactly like a worker.
    expect(nodeHasLiveSession("proj:director", live)).toBe(true);
  });

  it("is NOT live for a pane that isn't a cell of any launched tab", () => {
    expect(nodeHasLiveSession("proj:ghost", live)).toBe(false);
    expect(nodeHasLiveSession("proj:director", new Set())).toBe(false);
  });
});

describe("livePanesForProject (#3052 — bulk End sessions)", () => {
  const live = new Set(["cli:director", "cli:foundation", "cli:pages", "cli-typer:director", "other:worker"]);

  it("returns every live pane for the project — director + workers", () => {
    expect(livePanesForProject("cli", live).sort()).toEqual(["cli:director", "cli:foundation", "cli:pages"]);
  });

  it("matches the `<key>:` prefix EXACTLY — a project keyed `cli` never captures `cli-typer`'s panes", () => {
    expect(livePanesForProject("cli", live)).not.toContain("cli-typer:director");
    expect(livePanesForProject("cli-typer", live)).toEqual(["cli-typer:director"]);
  });

  it("is empty for a project with no live sessions, an empty live set, or a blank key", () => {
    expect(livePanesForProject("ghost", live)).toEqual([]);
    expect(livePanesForProject("cli", new Set())).toEqual([]);
    expect(livePanesForProject("", live)).toEqual([]);
  });
});
