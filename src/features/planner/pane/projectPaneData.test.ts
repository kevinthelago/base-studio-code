import { describe, it, expect } from "vitest";
import { buildProjectPaneData } from "./projectPaneData";
import type { BuildProjectPaneInput } from "./projectPaneData";
import { emptyFleet } from "../fleet/planFleet";
import type { FleetPlan } from "../fleet/planFleet";
import type { PlanIssue } from "../issues/planIssues";
import type { Section } from "../github/ghStructure";
import { PROFILES } from "@/features/agents/lib/agentProfiles";

function base(over: Partial<BuildProjectPaneInput> = {}): BuildProjectPaneInput {
  return {
    fleet: undefined,
    profiles: PROFILES,
    issues: [],
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

  it("forwards the project's skills to the focused Skills body (#1056)", () => {
    const d = buildProjectPaneData(base({
      skills: [{ name: "Real-time path tracing", kind: "skill", desc: "grounded denoiser notes" }],
    }));
    expect(d.skills).toEqual([{ name: "Real-time path tracing", kind: "skill", desc: "grounded denoiser notes" }]);
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
        profile: "pf_auto",
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
    expect(a.preset).toBe("Autonomous (trusted)");
    // perm derived from pf_auto tiers (read/edit/write->create/bash->run all allow)
    // + push auto-pr -> allow
    expect(a.perm.read).toBe("allow");
    expect(a.perm.edit).toBe("allow");
    expect(a.perm.create).toBe("allow");
    expect(a.perm.run).toBe("allow");
    expect(a.perm.push).toBe("allow");
  });

  it("a stream keeping its @name and no profile -> Autonomous default + push none deny", () => {
    const fleet = fleetWith([
      {
        id: "x", name: "@keep", repo: "o/r", owns: [], issues: [], dependsOn: [],
        flow: { autonomy: "continuous", push: "none", trigger: "per-issue", gate: "soft" },
      },
    ]);
    const d = buildProjectPaneData(base({ fleet }));
    expect(d.agents[0].name).toBe("@keep");
    // No explicit stream.profile → the worker's role default (Autonomous trusted).
    expect(d.agents[0].preset).toBe("Autonomous (trusted)");
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

  it("issues -> one repo milestone carrying all its issues; sub items come from acceptance (#1912)", () => {
    const issues: PlanIssue[] = [
      { ref: "A1", title: "Build A", acceptance: ["ac one", "ac two"], owns: [], dependsOn: ["B0"], labels: [], stream: "w" },
      { ref: "B1", title: "Build B", acceptance: [], owns: [], dependsOn: [], labels: ["done"] },
    ];
    // No repo on either issue → both attribute to the default (first) repo.
    const d = buildProjectPaneData(base({ issues, repos: ["o/api"] }));
    expect(d.structure).toHaveLength(1);
    const m = d.structure[0];
    expect(m.title).toBe("Issues");
    expect(m.repo).toBe("o/api");
    expect(m.epics[0].issues).toHaveLength(2);
    const a1 = m.epics[0].issues.find(i => i.n === "A1")!;
    expect(a1.owner).toBe("w");
    expect(a1.ac).toBe(2);
    expect(a1.deps).toEqual(["B0"]);
    expect(a1.sub).toEqual([{ t: "ac one", done: false }, { t: "ac two", done: false }]);
    // B1 is labelled done → counts toward the rollup (1 of 2 → 50%).
    const b1 = m.epics[0].issues.find(i => i.n === "B1")!;
    expect(b1.state).toBe("done");
    expect(m.pct).toBe(0.5);
  });

  it("derives cross-stream relationship edges from the issue dependency tree (#…)", () => {
    const fleet = fleetWith([
      { id: "schema", name: "@schema", repo: "o/core", owns: [], issues: ["S1"], dependsOn: [] },
      { id: "auth", name: "@auth", repo: "o/api", owns: [], issues: ["A1"], dependsOn: [] },
    ]);
    // A1 (auth) depends on S1 (schema) → a stream edge schema → auth.
    const issues: PlanIssue[] = [
      { ref: "S1", title: "schema", acceptance: [], owns: [], dependsOn: [], labels: [], stream: "schema" },
      { ref: "A1", title: "auth", acceptance: [], owns: [], dependsOn: ["S1"], labels: [], stream: "auth" },
    ];
    const d = buildProjectPaneData(base({ fleet, issues }));
    expect(d.relationships).toEqual([
      { id: "schema>auth", from: "schema", to: "auth", kind: "blocking", hardness: "blocking", via: "direct" },
    ]);
  });

  it("derives the stream graph from FEATURES when no fleet is authored yet (#plan-db)", () => {
    // No fleet (Structure stage, pre-Permissions): a feature IS a stream, so its dependsOn DAG
    // becomes the stream edges — the graph renders without waiting on fleet.json.
    const features = [
      { slug: "kernel", name: "Kernel", dependsOn: [] },
      { slug: "sketcher", name: "Sketcher", dependsOn: ["kernel"] },
    ];
    const d = buildProjectPaneData(base({ features }));
    expect(d.relationships).toEqual([
      { id: "kernel>sketcher", from: "kernel", to: "sketcher", kind: "blocking", hardness: "blocking", via: "direct" },
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
    const issues: PlanIssue[] = [
      // No static done label — would read backlog/0% without the overlay.
      { ref: "A1", title: "Build A", acceptance: ["ac one"], owns: [], dependsOn: [], labels: [], repo: "o/api" },
      { ref: "A2", title: "Build B", acceptance: [], owns: [], dependsOn: [], labels: [], repo: "o/api" },
    ];
    // The overlay marks A1's node closed (matched by `issue:{repo}:{ref}`); A2 absent.
    const progress = { "issue:o/api:A1": { done: true } };
    const d = buildProjectPaneData(base({ issues, repos: ["o/api"], progress }));
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
    const issues: PlanIssue[] = [
      { ref: "A1", title: "Build A", acceptance: [], owns: [], dependsOn: [], labels: ["closed"], repo: "o/api" },
    ];
    // Overlay present but doesn't cover A1 -> fall back to the static label.
    const d = buildProjectPaneData(base({ issues, repos: ["o/api"], progress: {} }));
    const m = d.structure[0];
    expect(m.pct).toBe(1);
    expect(m.epics[0].issues[0].state).toBe("done");
  });

  it("an open overlay node forces an issue with a stale done label back to not-done (#429)", () => {
    const issues: PlanIssue[] = [
      // Stale static label says done, but the live overlay says the issue is open.
      { ref: "A1", title: "Build A", acceptance: [], owns: [], dependsOn: [], labels: ["done"], repo: "o/api" },
    ];
    const progress = { "issue:o/api:A1": { done: false } };
    const d = buildProjectPaneData(base({ issues, repos: ["o/api"], progress }));
    expect(d.structure[0].pct).toBe(0);
    expect(d.structure[0].epics[0].issues[0].state).toBe("backlog");
  });

  it("an issue with no explicit repo attributes to the default (first) repo (#1912)", () => {
    const issues: PlanIssue[] = [
      { ref: "U1", title: "loose", acceptance: [], owns: [], dependsOn: [], labels: [] },
    ];
    const d = buildProjectPaneData(base({ issues, repos: ["o/api"] }));
    expect(d.structure).toHaveLength(1);
    expect(d.structure[0].repo).toBe("o/api");
    expect(d.structure[0].title).toBe("Issues");
    expect(d.structure[0].epics[0].issues[0].n).toBe("U1");
  });

  it("milestones are grouped per repo via each issue's repo field (#1912)", () => {
    const issues: PlanIssue[] = [
      { ref: "A1", title: "base work",   acceptance: [], owns: [], dependsOn: [], labels: [], repo: "o/api" },
      { ref: "B1", title: "mobile work", acceptance: [], owns: [], dependsOn: [], labels: [], repo: "o/mobile" },
    ];
    const d = buildProjectPaneData(base({ issues, repos: ["o/api", "o/mobile"] }));
    // One "Issues" milestone per repo — not one shared milestone.
    expect(d.structure).toHaveLength(2);
    const api = d.structure.find(m => m.repo === "o/api")!;
    const mob = d.structure.find(m => m.repo === "o/mobile")!;
    expect(api.title).toBe("Issues");
    expect(mob.title).toBe("Issues");
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

  it("omits the deprecated issues sections from context files (no ghost issues.md, #plan-db)", () => {
    const sections: Section[] = [
      { k: "goal", title: "Goal", state: "drafted", content: "g".repeat(300) },
      // A stale issues section with tiny content used to surface as a ghost "issues.md 0.0k".
      { k: "issues", title: "Issues", state: "drafted", content: "# Issues\n" },
      { k: "issues-phase1", title: "Issues — phase 1", state: "drafted", content: "- A1\n" },
    ];
    const d = buildProjectPaneData(base({ sections }));
    expect(d.context.map(c => c.name)).toEqual(["goal.md"]);
    expect(d.context.some(c => c.name.startsWith("issues"))).toBe(false);
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
