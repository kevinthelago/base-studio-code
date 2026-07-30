// Store projections (#2498) — pure per-domain payload shapes from store fixtures.
import { describe, it, expect } from "vitest";
import type { ProjectLite } from "@/features/glance";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Team } from "@/features/teams";
import type { Persona } from "@/features/personas";
import type { Blueprint } from "@/features/planner/stages/blueprintTypes";
import type { SkillDef } from "@/features/skills/lib/skillsModel";
import type { Kit, ComponentRecord, KitConsumer, KitLibraryRef } from "@/features/designs";
import type { Automation } from "@/features/automations/lib/scheduler";
import type { McpServer } from "@/features/mcp/lib/mcpServers";
import type { Hook } from "@/features/mcp/lib/hooks";
import {
  buildGlancePayload, buildOrgPayload, buildBlueprintsPayload, buildSkillsPayload,
  buildComponentsPayload, buildThemesPayload, buildAutomationsPayload, buildMcpPayload,
  buildAlertsPayload, AUTOMATION_RUNS_CAP,
  buildSecurityPayload, SECURITY_AUDIT_CAP,
} from "./storeProjections";
import type { AgentProfile, ConsoleSession, AuditDisplayRow } from "@/features/security";

// ── fixtures ─────────────────────────────────────────────────────────────────────

const fleet: FleetPlan = {
  recommended: 2,
  reasoning: "two lanes",
  streams: [
    { id: "auth", name: "Auth", repo: "acme/api", owns: ["src/auth/**"], issues: ["#1", "#2"], dependsOn: [], persona: "backend-dev" },
    { id: "ui", name: "UI", repo: "acme/web", owns: ["src/ui/**"], issues: ["#3"], dependsOn: ["auth"] },
  ],
  director: { enabled: true },
};

describe("buildGlancePayload", () => {
  const projects: ProjectLite[] = [
    { id: "demo", name: "Demo", role: "service", health: "healthy", activity: "building" },
    { id: "other", name: "Other", role: "client", health: "off", activity: "building" },
  ];
  const personas = [{ id: "backend-dev", role: "worker" }, { id: "lead", role: "director" }];

  it("overlays the fault health (error + reason + count) onto its project and passes links/drill through (#2541)", () => {
    const out = buildGlancePayload({
      projects,
      links: [{ id: "demo>other:api", from: "demo", to: "other", kind: "api" }],
      faults: { demo: { level: "error", title: "boom", count: 3 } },
      drill: "demo",
      fleets: { demo: fleet },
      personas,
    });
    expect(out.projects[0]).toMatchObject({ id: "demo", health: "error", reason: "boom", faults: 3 });
    expect(out.projects[1].faults).toBeUndefined();
    expect(out.projects[1].health).toBe("off"); // no fault → untouched
    expect(out.links).toHaveLength(1);
    expect(out.drill).toBe("demo");
    // The L1 fleet is DERIVED from the fleets map at the drilled key.
    expect(out.drillFleet).toBe(fleet);
  });

  it("carries no L1 fleet at the L0 network (drill null), but still ships the loaded fleets (#2530)", () => {
    const out = buildGlancePayload({ projects, links: [], faults: {}, drill: null, fleets: { demo: fleet }, personas });
    expect(out.drill).toBeNull();
    expect(out.drillFleet).toBeNull();
    expect(out.fleets).toEqual({ demo: fleet }); // present so a node can drill without being the active one
  });

  it("ships EVERY loaded project's fleet so any node drills, not just the drilled one (#2530)", () => {
    const other: FleetPlan = { recommended: 1, reasoning: "one lane", streams: [], director: { enabled: false } };
    const out = buildGlancePayload({ projects, links: [], faults: {}, drill: "other", fleets: { demo: fleet, other }, personas });
    expect(Object.keys(out.fleets).sort()).toEqual(["demo", "other"]);
    expect(out.drillFleet).toBe(other); // drilled 'other' resolves from the map
  });

  it("resolves persona id → role so mobile colours agents by their real role, not the worker default (#2530)", () => {
    const out = buildGlancePayload({ projects, links: [], faults: {}, drill: "demo", fleets: { demo: fleet }, personas });
    expect(out.personaRoles).toEqual({ "backend-dev": "worker", lead: "director" });
    // a stream's persona id resolves to its role through the map
    expect(out.personaRoles[fleet.streams[0].persona!]).toBe("worker");
  });

  it("carries the kit + library bands so mobile rebuilds the full cockpit, paring kits to id+name (#3743)", () => {
    const kits = [{ id: "react-ui", name: "React UI", tech: "react", style: "studio" }] as unknown as Kit[];
    const kitUsage = [{ projectKey: "demo", kitId: "react-ui" }] as unknown as KitConsumer[];
    const libraryRefs = [{ kitId: "react-ui", node: "dijkstra" }] as unknown as KitLibraryRef[];
    const out = buildGlancePayload({ projects, links: [], faults: {}, drill: null, fleets: {}, personas, kitUsage, kits, libraryRefs });
    // kits are pared to id+name (the wire node reads the name); kitUsage/libraryRefs pass through verbatim.
    expect(out.kits).toEqual([{ id: "react-ui", name: "React UI" }]);
    expect(out.kitUsage).toBe(kitUsage);
    expect(out.libraryRefs).toBe(libraryRefs);
  });

  it("defaults the kit + library bands to empty when omitted (#3743)", () => {
    const out = buildGlancePayload({ projects, links: [], faults: {}, drill: null, fleets: {}, personas });
    expect(out.kitUsage).toEqual([]);
    expect(out.kits).toEqual([]);
    expect(out.libraryRefs).toEqual([]);
  });
});

describe("buildOrgPayload", () => {
  it("keeps the org graphs whole and pares personas to refs (no start prompts)", () => {
    const org: Team = {
      id: "o1", name: "Pipeline",
      positions: [{ nodeId: "n1", kind: "agent", personaId: "p1" }],
      relationships: [{ id: "r1", archetype: "delegates", from: "n1", to: "n1" }],
    };
    const persona: Persona = {
      id: "p1", name: "Backend dev", blurb: "APIs", role: "worker",
      startPrompt: "SECRET-ish long prompt", skills: ["s1"], model: "sonnet", builtin: true,
    };
    const out = buildOrgPayload({ orgs: [org], personas: [persona] });
    expect(out.orgs[0].positions[0].personaId).toBe("p1");
    expect(out.personas[0]).toEqual({
      id: "p1", name: "Backend dev", blurb: "APIs", role: "worker",
      model: "sonnet", pooled: undefined, builtin: true,
    });
    expect(JSON.stringify(out)).not.toContain("SECRET-ish");
  });
});

describe("buildBlueprintsPayload", () => {
  const team = {
    positions: [{ nodeId: "n1", kind: "agent" as const, personaId: "p1" }],
    relationships: [],
  };
  const bp = (id: string, over: Partial<Blueprint> = {}): Blueprint => ({
    id, name: id, desc: "d", sections: [], ...over,
  });

  it("builds library cards with team presence + the uiKit pin, not full stage payloads", () => {
    const out = buildBlueprintsPayload({
      blueprints: [
        bp("default", { mode: "create", team, uiKit: { id: "bsc/react-ui", version: "1.2.0", hash: "abc", themeId: "soft" } }),
        bp("migrate", {}),
      ],
      activeBlueprintId: "default",
    });
    expect(out.library).toEqual([
      expect.objectContaining({ id: "default", hasTeam: true, uiKit: { id: "bsc/react-ui", version: "1.2.0", themeId: "soft" }, stageCount: 0 }),
      expect.objectContaining({ id: "migrate", hasTeam: false, uiKit: undefined }),
    ]);
    // The hash stays desktop-side; the card carries identity only.
    expect(JSON.stringify(out.library[0].uiKit)).not.toContain("abc");
  });

  it("carries the soundKit pin's identity too, with the hash left desktop-side (#3372)", () => {
    const out = buildBlueprintsPayload({
      blueprints: [
        bp("default", { soundKit: { id: "bsc/signal", version: "1.0.0", hash: "deadbeef", source: "https://gist.github.com/a/b" } }),
        bp("plain"),
      ],
      activeBlueprintId: "default",
    });
    expect(out.library[0].soundKit).toEqual({ id: "bsc/signal", version: "1.0.0" });
    expect(out.library[1].soundKit).toBeUndefined();
    expect(JSON.stringify(out.library[0].soundKit)).not.toContain("deadbeef");
  });

  it("carries the ACTIVE blueprint's team graph only", () => {
    const blueprints = [bp("a", { team }), bp("b", { team })];
    const out = buildBlueprintsPayload({ blueprints, activeBlueprintId: "b" });
    expect(out.active).toBe("b");
    expect(out.activeTeam).toBe(team);
    const none = buildBlueprintsPayload({ blueprints: [bp("c")], activeBlueprintId: "c" });
    expect(none.activeTeam).toBeNull();
  });
});

describe("buildSkillsPayload", () => {
  it("keeps library cards + groups + pending lessons, drops prompts and telemetry", () => {
    const skill: SkillDef = {
      id: "s1", name: "Review checklist", kind: "review", source: "user", desc: "PR review",
      prompt: "LONG PROMPT BODY", tools: [], profiles: [], projects: [], enabled: true, pinned: true,
      invocations: 42, success: 40, avgTokensK: 3, trend: [1, 2, 3],
    } as unknown as SkillDef;
    const out = buildSkillsPayload({
      skills: [skill],
      groups: [{ id: "g1", name: "Backend", hue: "var(--accent)", skillIds: ["s1"] }],
      lessons: {
        project: "demo",
        pending: [{ id: "l1", mistake: "m", cause: "c", rule: "r", provenance: "pane 1", status: "pending", seen: 2, createdAt: 1, updatedAt: 2 }],
      },
    });
    expect(out.skills[0]).toEqual({
      id: "s1", name: "Review checklist", kind: "review", source: "user", desc: "PR review",
      projects: [], enabled: true, pinned: true, packaged: undefined,
    });
    const json = JSON.stringify(out);
    expect(json).not.toContain("LONG PROMPT BODY"); // authoring content stays desktop-side
    expect(json).not.toContain("invocations");      // telemetry/analytics dropped on mobile
    expect(out.groups).toHaveLength(1);
    expect(out.lessons?.pending[0].rule).toBe("r");
  });

  it("carries null lessons when there is no active project", () => {
    expect(buildSkillsPayload({ skills: [], groups: [], lessons: null }).lessons).toBeNull();
  });
});

describe("buildComponentsPayload", () => {
  it("summarizes components (identity/classification/reuse) and drops source bodies", () => {
    const component: ComponentRecord = {
      id: "c1", name: "Button", kitId: "react-ui", role: "primitive", version: "1.0.0",
      used: 12, tags: ["control"], variants: ["ghost"], composes: [],
      props: [{ name: "kind", type: "string", req: false, desc: "visual kind" }],
      whenUse: ["actions"], whenNot: ["nav"], src: "src/Button.tsx", srcText: "SOURCE BODY",
    };
    const kit: Kit = { id: "react-ui", name: "React UI", stack: "React · TS", dot: "#7aa2ff" };
    const out = buildComponentsPayload({
      kits: [kit],
      components: [component],
      usage: [{ projectKey: "demo", kitId: "react-ui" }],
    });
    expect(out.kits).toEqual([kit]);
    expect(out.components[0]).toEqual({
      id: "c1", name: "Button", kitId: "react-ui", role: "primitive", version: "1.0.0",
      used: 12, tags: ["control"], variants: ["ghost"], composes: [], builtin: undefined,
    });
    expect(JSON.stringify(out)).not.toContain("SOURCE BODY");
    expect(out.usage[0].projectKey).toBe("demo");
  });
});

describe("buildThemesPayload", () => {
  it("carries the registry + the active theme id", () => {
    const out = buildThemesPayload({
      themes: [{ id: "soft", tech: "react", label: "Soft", description: "rounder", vars: { "--card-radius": "14px" }, builtin: true }],
      active: "soft",
    });
    expect(out.active).toBe("soft");
    expect(out.themes[0].vars["--card-radius"]).toBe("14px");
  });
});

describe("buildAutomationsPayload", () => {
  it("keeps schedule + recent runs (capped) and the hooks list, no analytics", () => {
    const automation: Automation = {
      id: "a1", name: "Nightly triage", armed: true,
      when: { kind: "simple", every: "day", at: "02:00" },
      targetTab: "build", targetPaneIdx: 0, action: "command", command: "triage",
      lastRunAt: 100, nextRunAt: 200,
      runs: Array.from({ length: 25 }, (_, i) => ({ at: i, status: "ok" as const, note: `run ${i}` })),
    };
    const hook: Hook = { id: "h1", name: "deny-floor", enabled: true, projects: [], event: "PreToolUse", command: "bsc-deny" };
    const out = buildAutomationsPayload({ automations: [automation], hooks: [hook] });
    expect(out.automations[0]).toMatchObject({ id: "a1", armed: true, lastRunAt: 100, nextRunAt: 200 });
    expect(out.automations[0].runs).toHaveLength(AUTOMATION_RUNS_CAP);
    expect(out.automations[0].runs[0].note).toBe("run 0"); // newest-first order preserved
    // The dispatch target/command stay desktop-side; the card is schedule + outcome.
    expect(JSON.stringify(out.automations)).not.toContain("targetTab");
    expect(out.hooks[0]).toEqual({ id: "h1", name: "deny-floor", enabled: true, event: "PreToolUse", matcher: undefined, projects: [] });
  });
});

describe("buildMcpPayload", () => {
  it("flags each server's installed status from the resolved set", () => {
    const servers: McpServer[] = [
      { id: "m1", name: "research", enabled: true, projects: [], transport: "stdio", command: "bsc", args: "mcp research" },
      { id: "m2", name: "custom", enabled: false, projects: ["demo"], transport: "http", url: "http://x" },
    ];
    const out = buildMcpPayload({ servers, installedIds: ["m1"] });
    expect(out.servers[0]).toMatchObject({ id: "m1", installed: true, transport: "stdio" });
    expect(out.servers[1]).toMatchObject({ id: "m2", installed: false, url: "http://x" });
    // env (may carry secrets) never rides to mobile.
    expect(JSON.stringify(out)).not.toContain("env");
  });
});

describe("buildAlertsPayload", () => {
  it("wraps the inbox", () => {
    const inbox = [{ id: "i", kind: "gate-ready" as const, text: "t", at: 1 }];
    expect(buildAlertsPayload(inbox)).toEqual({ alerts: inbox });
  });
});

describe("buildSecurityPayload (#2530 / #3754)", () => {
  const profile: AgentProfile = {
    id: "pf_worker", name: "Worker", color: "#fff", category: "user", origin: "user-defined", desc: "builds",
    mode: "ask", commands: ["git *"],
    tools: { read: "allow", grep: "allow", glob: "allow", edit: "ask", write: "ask", bash: "ask", web: "deny", task: "deny" },
    paths: { allow: ["src/**"], deny: [".env"] },
    net: { allow: ["api.github.com"] },
    builtin: false,
  };
  const appRole: AgentProfile = {
    ...profile, id: "sys_planner", name: "Project Planner", category: "application", origin: "built-in",
    surface: "Planner", surfaceGlyph: "◆", session: "planner", owns: "the plan",
  };
  const consoles: ConsoleSession[] = [{
    id: "t0", name: "Build", repo: "acme/api", status: "running",
    projectAllow: ["npm run build"], repoAllow: ["cargo test"],
    panes: [{ id: "t0p0", agent: "worker", status: "idle", profileId: "pf_worker" }],
  }];
  const row = (i: number): AuditDisplayRow => ({
    ts: `2026-07-25T10:${String(i).padStart(2, "0")}:00.000Z`,
    console: "Build", pane: "t0p0", profileId: "pf_worker", kind: "cmd", target: `cmd ${i}`, decision: "allow",
  });

  it("maps profiles (with color + origin), lists app roles first, projects consoles + assignments, caps audit", () => {
    const auditRows = Array.from({ length: SECURITY_AUDIT_CAP + 5 }, (_, i) => row(i));
    const out = buildSecurityPayload({
      appRoles: [appRole], profiles: [profile], consoles,
      paneRoles: { t0p0: "worker" }, paneProfiles: { t0p0: "pf_worker" }, auditRows,
    });
    // a plain profile card carries the config + swatch/origin; its undefined app-role fields are ignored by toEqual
    expect(out.profiles[0]).toEqual({
      id: "pf_worker", name: "Worker", category: "user", desc: "builds", mode: "ask",
      commands: ["git *"], tools: profile.tools,
      paths: { allow: ["src/**"], deny: [".env"] }, net: ["api.github.com"], builtin: false,
      color: "#fff", origin: "user-defined",
    });
    // application roles are a separate list, first, carrying their app-role-only fields
    expect(out.appRoles[0].id).toBe("sys_planner");
    expect(out.appRoles[0].session).toBe("planner");
    expect(out.appRoles[0].surface).toBe("Planner");
    // console cards carry the allowlist inputs mobile unions locally
    expect(out.consoles[0]).toEqual({
      id: "t0", name: "Build", repo: "acme/api",
      projectAllow: ["npm run build"], repoAllow: ["cargo test"],
      panes: [{ id: "t0p0", profileId: "pf_worker" }],
    });
    expect(out.paneRoles).toEqual({ t0p0: "worker" });
    expect(out.paneProfiles).toEqual({ t0p0: "pf_worker" });
    expect(out.audit).toHaveLength(SECURITY_AUDIT_CAP);  // capped at 50
    expect(out.audit[0].target).toBe("cmd 0");           // newest-first order preserved
    expect(out.audit[0].decision).toBe("allow");         // the desktop-computed verdict crosses the wire
  });

  it("crosses no secrets — net is a host allowlist, and a plain profile's app-role fields drop off the wire", () => {
    const out = buildSecurityPayload({
      appRoles: [], profiles: [profile], consoles: [], paneRoles: {}, paneProfiles: {}, auditRows: [],
    });
    const json = JSON.stringify(out);
    // a plain profile has no surface/session — undefined, so JSON.stringify drops them entirely
    expect(json).not.toContain("surface");
    expect(json).not.toContain("session");
    expect(out.profiles[0].net).toEqual(["api.github.com"]); // a host allowlist, not credentials
  });
});
