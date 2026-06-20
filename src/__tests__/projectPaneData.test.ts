import { describe, it, expect } from "vitest";
import { buildProjectPaneData } from "../screens/planner/projectPaneData";
import type { BuildProjectPaneInput } from "../screens/planner/projectPaneData";
import { emptyFleet } from "../screens/planner/stages/planSections";
import type { FleetPlan } from "../screens/planner/stages/planSections";
import type { PlanIssue } from "../screens/planner/issues/planIssues";
import type { Section } from "../screens/planner/github/ghStructure";
import { PROFILES } from "../screens/agents/agentProfiles";

function base(over: Partial<BuildProjectPaneInput> = {}): BuildProjectPaneInput {
  return {
    fleet: undefined,
    profiles: PROFILES,
    issues: [],
    phases: [],
    repos: [],
    sections: [],
    ...over,
  };
}

function fleetWith(streams: FleetPlan["streams"]): FleetPlan {
  return { ...emptyFleet(), streams };
}

describe("buildProjectPaneData", () => {
  it("empty input -> all empty arrays", () => {
    const d = buildProjectPaneData(base());
    expect(d.agents).toEqual([]);
    expect(d.repos).toEqual([]);
    expect(d.structure).toEqual([]);
    expect(d.context).toEqual([]);
  });

  it("hides empty section files so ghost 0.0k context files don't show (#654)", () => {
    const d = buildProjectPaneData(base({ sections: [
      { k: "goal", title: "Goal", content: "   ", state: "confirmed" } as unknown as Section,
      { k: "scope", title: "Scope", content: "We will build X.", state: "draft" } as unknown as Section,
    ] }));
    // The display filename is the canonical KEY (matches the on-disk file), not the title (#803).
    expect(d.context.map(c => c.name)).toEqual(["scope.md"]);
  });

  it("names context files by their canonical key, matching the on-disk file (#803)", () => {
    const d = buildProjectPaneData(base({ sections: [
      { k: "stack", title: "Tech stack", content: "Rust + React.", state: "confirmed" } as unknown as Section,
    ] }));
    expect(d.context.map(c => c.name)).toEqual(["stack.md"]); // not "Tech stack.md"
  });

  it("a fleet stream -> one agent with mapped flow push casing + derived perm", () => {
    const fleet = fleetWith([
      {
        id: "auth-ui",
        name: "Auth UI",
        repo: "acme/web",
        owns: ["src/auth/**", "src/login/**"],
        issues: ["#12"],
        dependsOn: [],
        profile: "pf_build",
        flow: { autonomy: "checkpoint", push: "auto-pr", trigger: "per-issue", gate: "hard" },
      },
    ]);
    const d = buildProjectPaneData(base({ fleet }));
    expect(d.agents).toHaveLength(1);
    const a = d.agents[0];
    expect(a.id).toBe("auth-ui");
    // name without leading @ -> "@" + id
    expect(a.name).toBe("@auth-ui");
    expect(a.repo).toBe("acme/web");
    expect(a.owns).toEqual(["src/auth/**", "src/login/**"]);
    expect(a.issues).toEqual(["#12"]);
    expect(a.role).toBe("worker");
    expect(a.initial).toBe("A");
    // push "auto-pr" -> "auto-PR"
    expect(a.flow.push).toBe("auto-PR");
    expect(a.flow.autonomy).toBe("checkpoint");
    expect(a.flow.gate).toBe("hard");
    // preset name from the assigned profile
    expect(a.preset).toBe("Build & test");
    // perm derived from pf_build tiers (read allow, edit allow, write->create allow,
    // bash->run ask) + push auto-pr -> allow
    expect(a.perm.read).toBe("allow");
    expect(a.perm.edit).toBe("allow");
    expect(a.perm.create).toBe("allow");
    expect(a.perm.run).toBe("ask");
    expect(a.perm.push).toBe("allow");
  });

  it("a stream keeping its @name and no profile -> Custom preset + push none deny", () => {
    const fleet = fleetWith([
      {
        id: "x", name: "@keep", repo: "o/r", owns: [], issues: [], dependsOn: [],
        flow: { autonomy: "continuous", push: "none", trigger: "per-issue", gate: "soft" },
      },
    ]);
    const d = buildProjectPaneData(base({ fleet }));
    expect(d.agents[0].name).toBe("@keep");
    expect(d.agents[0].preset).toBe("Custom");
    expect(d.agents[0].perm.push).toBe("deny");
  });

  it("repos -> one repo entry each, primary on the first, agents linked by repo", () => {
    const fleet = fleetWith([
      { id: "w", name: "@w", repo: "o/api", owns: [], issues: [], dependsOn: [] },
    ]);
    const d = buildProjectPaneData(base({ fleet, repos: ["o/api", "o/web"] }));
    expect(d.repos.map(r => r.id)).toEqual(["o/api", "o/web"]);
    expect(d.repos[0].primary).toBe(true);
    expect(d.repos[1].primary).toBe(false);
    expect(d.repos[0].agents).toEqual(["w"]);
    expect(d.repos[1].agents).toEqual([]);
  });

  it("repos carry clone status + a planned branch per owning stream (#674)", () => {
    const fleet = fleetWith([
      { id: "stream-api", name: "@api", repo: "o/api", owns: [], issues: ["42", "43"], dependsOn: [] },
    ]);
    const d = buildProjectPaneData(base({ fleet, repos: ["o/api", "o/web"], clonedNames: ["o/api"] }));
    expect(d.repos[0].cloned).toBe(true);
    expect(d.repos[1].cloned).toBe(false);
    // one planned branch (= the owning stream), tagged with its first numeric issue
    expect(d.repos[0].branches).toEqual([{ n: "stream-api", issue: 42, state: "draft", ahead: 0, behind: 0 }]);
    expect(d.repos[1].branches).toEqual([]);
  });

  it("phases + issues -> milestones with issues; sub items come from acceptance", () => {
    const phases = [{ name: "Phase 1" }, { name: "Phase 2" }];
    const issues: PlanIssue[] = [
      { ref: "A1", title: "Build A", phase: 1, acceptance: ["ac one", "ac two"], owns: [], dependsOn: ["B0"], labels: [], stream: "w" },
      { ref: "B1", title: "Build B", phase: 2, acceptance: [], owns: [], dependsOn: [], labels: ["done"] },
    ];
    const d = buildProjectPaneData(base({ phases, issues, repos: ["o/api"] }));
    expect(d.structure).toHaveLength(2);
    const m1 = d.structure[0];
    expect(m1.title).toBe("Phase 1");
    expect(m1.epics[0].issues).toHaveLength(1);
    const iss = m1.epics[0].issues[0];
    expect(iss.n).toBe("A1");
    expect(iss.owner).toBe("w");
    expect(iss.ac).toBe(2);
    expect(iss.deps).toEqual(["B0"]);
    expect(iss.sub).toEqual([{ t: "ac one", done: false }, { t: "ac two", done: false }]);
    // Phase 2's single issue is labelled done -> pct 1, state done.
    const m2 = d.structure[1];
    expect(m2.pct).toBe(1);
    expect(m2.epics[0].issues[0].state).toBe("done");
  });

  it("derives cross-stream relationship edges from the issue dependency tree (#…)", () => {
    const fleet = fleetWith([
      { id: "schema", name: "@schema", repo: "o/core", owns: [], issues: ["S1"], dependsOn: [] },
      { id: "auth", name: "@auth", repo: "o/api", owns: [], issues: ["A1"], dependsOn: [] },
    ]);
    // A1 (auth) depends on S1 (schema) → a stream edge schema → auth.
    const issues: PlanIssue[] = [
      { ref: "S1", title: "schema", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [], stream: "schema" },
      { ref: "A1", title: "auth", phase: 2, acceptance: [], owns: [], dependsOn: ["S1"], labels: [], stream: "auth" },
    ];
    const d = buildProjectPaneData(base({ fleet, issues }));
    expect(d.relationships).toEqual([
      { id: "schema>auth", from: "schema", to: "auth", kind: "blocking", hardness: "blocking", via: "direct" },
    ]);
  });

  it("uses the planner's explicit fleet edges over derivation when present (#…)", () => {
    const fleet: FleetPlan = {
      ...fleetWith([{ id: "a", name: "@a", repo: "o/r", owns: [], issues: [], dependsOn: [] }]),
      edges: [{ id: "e", from: "a", to: "b", kind: "handoff", hardness: "soft", via: "direct" }],
    };
    const d = buildProjectPaneData(base({ fleet }));
    expect(d.relationships).toEqual([{ id: "e", from: "a", to: "b", kind: "handoff", hardness: "soft", via: "direct" }]);
  });

  it("live progress overlay drives done-state + pct, overriding the static label (#429)", () => {
    const phases = [{ name: "Phase 1" }];
    const issues: PlanIssue[] = [
      // No static done label — would read backlog/0% without the overlay.
      { ref: "A1", title: "Build A", phase: 1, acceptance: ["ac one"], owns: [], dependsOn: [], labels: [], repo: "o/api" },
      { ref: "A2", title: "Build B", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [], repo: "o/api" },
    ];
    // The overlay marks A1's node closed (matched by `issue:{repo}:{ref}`); A2 absent.
    const progress = { "issue:o/api:A1": { done: true } };
    const d = buildProjectPaneData(base({ phases, issues, repos: ["o/api"], progress }));
    const m = d.structure[0];
    // One of two issues done -> 50%.
    expect(m.pct).toBe(0.5);
    expect(m.epics[0].pct).toBe(0.5);
    const a1 = m.epics[0].issues.find(i => i.n === "A1")!;
    const a2 = m.epics[0].issues.find(i => i.n === "A2")!;
    expect(a1.state).toBe("done");
    expect(a2.state).toBe("backlog");
    // A closed issue's acceptance sub-items read as met so the drill-in agrees.
    expect(a1.sub).toEqual([{ t: "ac one", done: true }]);
  });

  it("static done/closed label still marks an issue done when the overlay has no node (#429 fallback)", () => {
    const phases = [{ name: "Phase 1" }];
    const issues: PlanIssue[] = [
      { ref: "A1", title: "Build A", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: ["closed"], repo: "o/api" },
    ];
    // Overlay present but doesn't cover A1 -> fall back to the static label.
    const d = buildProjectPaneData(base({ phases, issues, repos: ["o/api"], progress: {} }));
    const m = d.structure[0];
    expect(m.pct).toBe(1);
    expect(m.epics[0].issues[0].state).toBe("done");
  });

  it("an open overlay node forces an issue with a stale done label back to not-done (#429)", () => {
    const phases = [{ name: "Phase 1" }];
    const issues: PlanIssue[] = [
      // Stale static label says done, but the live overlay says the issue is open.
      { ref: "A1", title: "Build A", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: ["done"], repo: "o/api" },
    ];
    const progress = { "issue:o/api:A1": { done: false } };
    const d = buildProjectPaneData(base({ phases, issues, repos: ["o/api"], progress }));
    expect(d.structure[0].pct).toBe(0);
    expect(d.structure[0].epics[0].issues[0].state).toBe("backlog");
  });

  it("issues with unknown phase land under a trailing Unscheduled milestone", () => {
    const phases = [{ name: "Phase 1" }];
    const issues: PlanIssue[] = [
      { ref: "U1", title: "loose", phase: undefined, acceptance: [], owns: [], dependsOn: [], labels: [] },
    ];
    const d = buildProjectPaneData(base({ phases, issues }));
    // The empty Phase 1 (no issues) is skipped; only the Unscheduled bucket remains.
    expect(d.structure).toHaveLength(1);
    expect(d.structure[0].title).toBe("Unscheduled");
    expect(d.structure[0].epics[0].issues[0].n).toBe("U1");
  });

  it("milestones are grouped per repo via each issue's repo field", () => {
    const phases = [{ name: "Phase 1" }];
    const issues: PlanIssue[] = [
      { ref: "A1", title: "base work",   phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [], repo: "o/api" },
      { ref: "B1", title: "mobile work", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [], repo: "o/mobile" },
    ];
    const d = buildProjectPaneData(base({ phases, issues, repos: ["o/api", "o/mobile"] }));
    // One (repo, phase) milestone per repo — not one shared milestone.
    expect(d.structure).toHaveLength(2);
    const api = d.structure.find(m => m.repo === "o/api")!;
    const mob = d.structure.find(m => m.repo === "o/mobile")!;
    expect(api.epics[0].issues.map(i => i.n)).toEqual(["A1"]);
    expect(mob.epics[0].issues.map(i => i.n)).toEqual(["B1"]);
  });

  it("sections -> context files; pinned reflects confirmed state", () => {
    const sections: Section[] = [
      { k: "claude", title: "CLAUDE", state: "confirmed", content: "x".repeat(1200) },
      { k: "settlement_spec", title: "Settlement spec", state: "drafted", content: "y".repeat(4100) },
      { k: "goal", title: "Goal", state: "pending", content: "g".repeat(300) },
    ];
    const d = buildProjectPaneData(base({ sections }));
    expect(d.context).toHaveLength(3);
    const claude = d.context.find(c => c.name === "CLAUDE.md")!;
    expect(claude.kind).toBe("claude");
    expect(claude.pinned).toBe(true);
    expect(claude.tok).toBe("1.2k");
    const spec = d.context.find(c => c.name === "settlement_spec.md")!;
    expect(spec.kind).toBe("spec");
    expect(spec.pinned).toBe(false);
    expect(spec.tok).toBe("4.1k");
    const goal = d.context.find(c => c.name === "goal.md")!;
    expect(goal.kind).toBe("doc");
    expect(goal.pinned).toBe(false);
  });

  it("stream.perm overrides the profile-derived perm", () => {
    const fleet = fleetWith([
      {
        id: "auth-ui", name: "Auth UI", repo: "acme/web", owns: [], issues: [], dependsOn: [],
        profile: "pf_build",
        perm: { read: "deny", edit: "deny", create: "deny", run: "deny", net: "deny", push: "deny", pkg: "deny" },
      },
    ]);
    const d = buildProjectPaneData(base({ fleet }));
    // pf_build would derive read=allow; the explicit perm wins.
    expect(d.agents[0].perm.read).toBe("deny");
    expect(d.agents[0].perm.push).toBe("deny");
  });

  it("stream.preset overrides the profile-derived preset", () => {
    const fleet = fleetWith([
      { id: "x", name: "@x", repo: "o/r", owns: [], issues: [], dependsOn: [], profile: "pf_build", preset: "custom" },
    ]);
    const d = buildProjectPaneData(base({ fleet }));
    expect(d.agents[0].preset).toBe("custom");
  });

  it("an explicit pinned set drives context pinned (overriding confirmed default)", () => {
    const sections: Section[] = [
      { k: "claude", title: "CLAUDE", state: "confirmed", content: "x".repeat(1200) },
      { k: "settlement_spec", title: "Settlement spec", state: "drafted", content: "y".repeat(4100) },
    ];
    // Pin only the spec (which is NOT confirmed); CLAUDE (confirmed) is not in the set.
    const d = buildProjectPaneData(base({ sections, pinned: ["settlement_spec.md"] }));
    expect(d.context.find(c => c.name === "settlement_spec.md")!.pinned).toBe(true);
    expect(d.context.find(c => c.name === "CLAUDE.md")!.pinned).toBe(false);
  });

  it("an empty pinned set unpins everything (explicit set, no confirmed fallback)", () => {
    const sections: Section[] = [
      { k: "claude", title: "CLAUDE", state: "confirmed", content: "x".repeat(1200) },
    ];
    const d = buildProjectPaneData(base({ sections, pinned: [] }));
    expect(d.context[0].pinned).toBe(false);
  });
});

describe("buildProjectPaneData · phaseStructure (#497)", () => {
  it("groups issues by phase PROJECT-WIDE (across repos), one phase per roadmap entry", () => {
    const issues: PlanIssue[] = [
      { ref: "A1", title: "API thing", phase: 1, acceptance: ["x"], owns: [], dependsOn: [], labels: [], repo: "o/api" },
      { ref: "W1", title: "Web thing", phase: 1, acceptance: [], owns: [], dependsOn: ["A1"], labels: [], repo: "o/web" },
      { ref: "A2", title: "Phase 2 thing", phase: 2, acceptance: [], owns: [], dependsOn: [], labels: [], repo: "o/api" },
    ];
    const phases = [{ name: "MVP", description: "ships e2e" }, { name: "Polish" }];
    const d = buildProjectPaneData(base({ issues, phases, repos: ["o/api", "o/web"] }));

    // One PhaseGroup per phase (the roadmap), in order — not per (repo, phase).
    expect(d.phaseStructure.map(p => p.name)).toEqual(["MVP", "Polish"]);
    const mvp = d.phaseStructure[0];
    expect(mvp.doneWhen).toBe("ships e2e");
    expect(mvp.order).toBe(0);
    // MVP spans BOTH repos.
    expect(mvp.total).toBe(2);
    expect(mvp.issues.map(i => i.repo).sort()).toEqual(["o/api", "o/web"]);
  });

  it("rolls up closed/total/pct per phase from the live overlay + static labels", () => {
    const issues: PlanIssue[] = [
      { ref: "A1", title: "done one", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: ["closed"], repo: "o/api" },
      { ref: "A2", title: "open one", phase: 1, acceptance: [], owns: [], dependsOn: [], labels: [], repo: "o/api" },
    ];
    const d = buildProjectPaneData(base({ issues, phases: [{ name: "P1" }], repos: ["o/api"] }));
    const p1 = d.phaseStructure[0];
    expect(p1.closed).toBe(1);
    expect(p1.total).toBe(2);
    expect(p1.pct).toBe(0.5);
  });

  it("shows empty phases (the roadmap) and sweeps unresolved issues into Unscheduled", () => {
    const issues: PlanIssue[] = [
      { ref: "U1", title: "no phase", phase: undefined as unknown as number, acceptance: [], owns: [], dependsOn: [], labels: [], repo: "o/api" },
    ];
    const phases = [{ name: "P1" }, { name: "P2" }];
    const d = buildProjectPaneData(base({ issues, phases, repos: ["o/api"] }));
    // Both phases present even with no issues, plus a trailing Unscheduled group.
    expect(d.phaseStructure.map(p => p.name)).toEqual(["P1", "P2", "Unscheduled"]);
    expect(d.phaseStructure[0].total).toBe(0);
    expect(d.phaseStructure[2].issues[0].n).toBe("U1");
  });
});
